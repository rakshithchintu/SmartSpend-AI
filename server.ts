import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Runtime requires dev server on port 3000
const PORT = 3000;

// Initialize Gemini Client
const apiKey = process.env.GEMINI_API_KEY;
let ai: GoogleGenAI | null = null;

if (apiKey) {
  ai = new GoogleGenAI({
    apiKey: apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// Timeout helper with generous 20s window for LLM JSON generation
function withTimeout<T>(promise: Promise<T>, ms: number = 20000, fallbackMsg = 'Gemini timeout'): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(fallbackMsg)), ms)),
  ]);
}

// Gemini API Circuit Breaker State
type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
type TripReason = '429_QUOTA' | '503_UNAVAILABLE' | 'TIMEOUT' | null;

let circuitState: CircuitBreakerState = 'CLOSED';
let circuitTripReason: TripReason = null;
let circuitTrippedAt: number | null = null;
let circuitCooldownUntil: number | null = null;
let circuitLoggedTrip = false; // Ensures we do not repeatedly log errors during circuit trip
let failureCount = 0;

let isQuotaExhausted = false; // Kept in sync with 429 state
let quotaExhaustedAt: number | null = null;
let cachedAiAnalysis: any = null;
let cachedAiRecommendations: any = null;

const FRIENDLY_UNAVAILABLE_MESSAGE =
  'Gemini AI is temporarily unavailable. Offline analysis is active.';
const QUOTA_EXHAUSTED_MESSAGE = FRIENDLY_UNAVAILABLE_MESSAGE;

// Error detection helpers
function is429Error(err: any): boolean {
  if (!err) return false;
  const msg = String(err.message || err.toString() || '').toLowerCase();
  const status = err.status || err.statusCode || (err.response && err.response.status);
  return (
    status === 429 ||
    msg.includes('429') ||
    msg.includes('quota') ||
    msg.includes('resource_exhausted') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests')
  );
}

function is503Error(err: any): boolean {
  if (!err) return false;
  const msg = String(err.message || err.toString() || '').toLowerCase();
  const status = err.status || err.statusCode || (err.response && err.response.status);
  return (
    status === 503 ||
    status === 502 ||
    msg.includes('503') ||
    msg.includes('502') ||
    msg.includes('unavailable') ||
    msg.includes('service unavailable') ||
    msg.includes('bad gateway')
  );
}

function isTimeoutError(err: any): boolean {
  if (!err) return false;
  const msg = String(err.message || err.toString() || '').toLowerCase();
  const status = err.status || err.statusCode || (err.response && err.response.status);
  return (
    status === 504 ||
    status === 408 ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('aborterror') ||
    msg.includes('deadline exceeded')
  );
}

function tripCircuit(reason: TripReason, err?: any) {
  circuitState = 'OPEN';
  circuitTripReason = reason;
  circuitTrippedAt = Date.now();
  failureCount++;

  if (reason === '429_QUOTA') {
    isQuotaExhausted = true;
    quotaExhaustedAt = circuitTrippedAt;
    circuitCooldownUntil = null; // Stays OPEN until manual reset or confirmation
  } else if (reason === '503_UNAVAILABLE') {
    circuitCooldownUntil = Date.now() + 60000; // 60s cooldown to avoid immediate retries
  } else if (reason === 'TIMEOUT') {
    circuitCooldownUntil = Date.now() + 45000; // 45s cooldown
  }

  if (!circuitLoggedTrip) {
    console.warn(
      `[SmartSpend AI Circuit Breaker] ${FRIENDLY_UNAVAILABLE_MESSAGE} (Reason: ${reason}, Details: ${err?.message || err || 'Tripped'})`
    );
    circuitLoggedTrip = true; // Log only ONCE per trip cycle
  }
}

function resetCircuit() {
  circuitState = 'CLOSED';
  circuitTripReason = null;
  circuitTrippedAt = null;
  circuitCooldownUntil = null;
  circuitLoggedTrip = false;
  failureCount = 0;
  isQuotaExhausted = false;
  quotaExhaustedAt = null;
}

function isCircuitOpen(): boolean {
  if (circuitState === 'CLOSED') return false;

  const now = Date.now();
  if (circuitTripReason === '429_QUOTA') {
    return true; // Pauses until quota reset or manual confirmation
  }

  if (circuitCooldownUntil && now < circuitCooldownUntil) {
    return true;
  }

  // Cooldown elapsed: allow a probe attempt in HALF_OPEN
  if (circuitState === 'OPEN') {
    circuitState = 'HALF_OPEN';
  }
  return false;
}

// Health check endpoint
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    currency: 'INR',
    symbol: '₹',
    geminiConfigured: !!apiKey,
    model: 'gemini-3.8-flash',
    circuitState,
    isCircuitOpen: isCircuitOpen(),
    isQuotaExhausted,
  });
});

// Circuit Breaker & Quota Status endpoint
app.get('/api/ai/circuit-status', (req: Request, res: Response) => {
  const open = isCircuitOpen();
  const now = Date.now();
  res.json({
    circuitState,
    tripReason: circuitTripReason,
    isUnavailable: open,
    isQuotaExhausted,
    trippedAt: circuitTrippedAt,
    cooldownRemainingMs: circuitCooldownUntil ? Math.max(0, circuitCooldownUntil - now) : (circuitTripReason === '429_QUOTA' ? Infinity : 0),
    quotaMessage: open ? FRIENDLY_UNAVAILABLE_MESSAGE : null,
    hasCachedAnalysis: !!cachedAiAnalysis,
    hasCachedRecommendations: !!cachedAiRecommendations,
    failureCount,
  });
});

// Backwards compatibility endpoint for quota-status
app.get('/api/ai/quota-status', (req: Request, res: Response) => {
  const open = isCircuitOpen();
  res.json({
    isQuotaExhausted: open || isQuotaExhausted,
    isUnavailable: open,
    circuitState,
    tripReason: circuitTripReason,
    quotaExhaustedAt,
    quotaMessage: open ? FRIENDLY_UNAVAILABLE_MESSAGE : null,
    hasCachedAnalysis: !!cachedAiAnalysis,
    hasCachedRecommendations: !!cachedAiRecommendations,
  });
});

// Manual Reset Quota & Circuit endpoint
app.post('/api/ai/reset-quota', (req: Request, res: Response) => {
  resetCircuit();
  res.json({
    isQuotaExhausted: false,
    circuitState: 'CLOSED',
    message: 'Circuit breaker reset successfully. Live Gemini AI requests re-enabled.',
  });
});

app.post('/api/ai/reset-circuit', (req: Request, res: Response) => {
  resetCircuit();
  res.json({
    isQuotaExhausted: false,
    circuitState: 'CLOSED',
    message: 'Circuit breaker reset successfully. Live Gemini AI requests re-enabled.',
  });
});

// Simulation endpoint for 429, 503, and timeout errors without making Gemini calls
app.post('/api/ai/simulate-error', (req: Request, res: Response) => {
  const { errorType } = req.body;
  circuitLoggedTrip = false; // Reset log flag for test verification

  if (errorType === '429' || errorType === 'quota') {
    tripCircuit('429_QUOTA', new Error('Simulated HTTP 429 RESOURCE_EXHAUSTED'));
  } else if (errorType === '503' || errorType === 'unavailable') {
    tripCircuit('503_UNAVAILABLE', new Error('Simulated HTTP 503 UNAVAILABLE'));
  } else if (errorType === 'timeout') {
    tripCircuit('TIMEOUT', new Error('Simulated Network Timeout'));
  } else if (errorType === 'reset') {
    resetCircuit();
  } else {
    // Default to 429 for test backward compatibility
    tripCircuit('429_QUOTA', new Error('Simulated HTTP 429 Error'));
  }

  res.json({
    circuitState,
    tripReason: circuitTripReason,
    isUnavailable: isCircuitOpen(),
    quotaMessage: isCircuitOpen() ? FRIENDLY_UNAVAILABLE_MESSAGE : null,
    message: `Simulated error '${errorType || '429'}' processed. Circuit is ${circuitState}.`,
  });
});

// Legacy simulation endpoint support
app.post('/api/ai/simulate-quota', (req: Request, res: Response) => {
  const shouldExhaust = req.body?.exhausted !== false;
  circuitLoggedTrip = false;
  if (shouldExhaust) {
    tripCircuit('429_QUOTA', new Error('Simulated HTTP 429 quota exhaustion test'));
  } else {
    resetCircuit();
  }
  res.json({
    isQuotaExhausted: isCircuitOpen(),
    circuitState,
    tripReason: circuitTripReason,
    quotaMessage: isCircuitOpen() ? FRIENDLY_UNAVAILABLE_MESSAGE : null,
    message: shouldExhaust
      ? 'Quota exhaustion simulated successfully. Server is now serving offline recommendations.'
      : 'Quota simulation cleared.',
  });
});

// Heuristic fallback categorizer with Indian merchant awareness
function heuristicCategorize(description: string, defaultType: string = 'expense') {
  const desc = description.toLowerCase();

  // Income indicators
  if (
    desc.includes('salary') ||
    desc.includes('paycheck') ||
    desc.includes('payroll') ||
    desc.includes('wage') ||
    desc.includes('stipend') ||
    desc.includes('bonus') ||
    desc.includes('allowance')
  ) {
    return {
      category: 'Salary & Wages',
      type: 'income',
      confidence: 0.96,
      reasoning: 'Identified corporate employment compensation or stipend credits',
    };
  }
  if (
    desc.includes('freelance') ||
    desc.includes('consulting') ||
    desc.includes('tutoring') ||
    desc.includes('client') ||
    desc.includes('upwork') ||
    desc.includes('fiverr') ||
    desc.includes('contract') ||
    desc.includes('project payment')
  ) {
    return {
      category: 'Freelance & Consulting',
      type: 'income',
      confidence: 0.94,
      reasoning: 'Recognized freelance service and client milestone invoice',
    };
  }
  if (
    desc.includes('dividend') ||
    desc.includes('mutual fund') ||
    desc.includes('sip') ||
    desc.includes('zerodha') ||
    desc.includes('groww') ||
    desc.includes('stock') ||
    desc.includes('interest') ||
    desc.includes('fixed deposit') ||
    desc.includes('fd interest')
  ) {
    return {
      category: 'Investments & Dividends',
      type: 'income',
      confidence: 0.93,
      reasoning: 'Identified investment return or dividend distribution',
    };
  }
  if (
    desc.includes('scholarship') ||
    desc.includes('grant') ||
    desc.includes('gift') ||
    desc.includes('family transfer') ||
    desc.includes('parent')
  ) {
    return {
      category: 'Gifts & Grants',
      type: 'income',
      confidence: 0.90,
      reasoning: 'Identified academic grant or family transfer',
    };
  }

  // Expense indicators
  if (
    desc.includes('swiggy') ||
    desc.includes('zomato') ||
    desc.includes('restaurant') ||
    desc.includes('cafe') ||
    desc.includes('coffee') ||
    desc.includes('blue tokai') ||
    desc.includes('chai') ||
    desc.includes('mcdonald') ||
    desc.includes('domino') ||
    desc.includes('pizza') ||
    desc.includes('burger') ||
    desc.includes('biryani') ||
    desc.includes('dining') ||
    desc.includes('lunch') ||
    desc.includes('dinner')
  ) {
    return {
      category: 'Food & Dining',
      type: 'expense',
      confidence: 0.96,
      reasoning: 'Identified food delivery or dining restaurant merchant',
    };
  }
  if (
    desc.includes('zepto') ||
    desc.includes('blinkit') ||
    desc.includes('instamart') ||
    desc.includes('bigbasket') ||
    desc.includes('dunzo') ||
    desc.includes('supermarket') ||
    desc.includes('grocery') ||
    desc.includes('nature\'s basket') ||
    desc.includes('dmart') ||
    desc.includes('more retail') ||
    desc.includes('spencer')
  ) {
    return {
      category: 'Groceries',
      type: 'expense',
      confidence: 0.95,
      reasoning: 'Supermarket or quick-commerce grocery delivery identified',
    };
  }
  if (
    desc.includes('rent') ||
    desc.includes('maintenance') ||
    desc.includes('society') ||
    desc.includes('apartment') ||
    desc.includes('hostel') ||
    desc.includes('pg ') ||
    desc.includes('flatmate') ||
    desc.includes('landlord')
  ) {
    return {
      category: 'Housing & Rent',
      type: 'expense',
      confidence: 0.98,
      reasoning: 'Residential rent or apartment maintenance detected',
    };
  }
  if (
    desc.includes('uber') ||
    desc.includes('ola') ||
    desc.includes('rapido') ||
    desc.includes('metro') ||
    desc.includes('auto') ||
    desc.includes('petrol') ||
    desc.includes('diesel') ||
    desc.includes('fuel') ||
    desc.includes('fastag') ||
    desc.includes('irctc') ||
    desc.includes('train') ||
    desc.includes('bus')
  ) {
    return {
      category: 'Transportation',
      type: 'expense',
      confidence: 0.94,
      reasoning: 'Urban commute, rideshare, or vehicle fuel expense',
    };
  }
  if (
    desc.includes('bescom') ||
    desc.includes('electricity') ||
    desc.includes('power') ||
    desc.includes('wifi') ||
    desc.includes('broadband') ||
    desc.includes('jio') ||
    desc.includes('airtel') ||
    desc.includes('vodafone') ||
    desc.includes('gas cylinder') ||
    desc.includes('indane') ||
    desc.includes('water bill')
  ) {
    return {
      category: 'Utilities',
      type: 'expense',
      confidence: 0.95,
      reasoning: 'Household municipal utility, power, or telecom charge',
    };
  }
  if (
    desc.includes('netflix') ||
    desc.includes('spotify') ||
    desc.includes('hotstar') ||
    desc.includes('prime') ||
    desc.includes('youtube') ||
    desc.includes('sonyliv') ||
    desc.includes('zee5') ||
    desc.includes('chatgpt') ||
    desc.includes('github') ||
    desc.includes('apple') ||
    desc.includes('icloud')
  ) {
    return {
      category: 'Subscriptions',
      type: 'expense',
      confidence: 0.96,
      reasoning: 'Recurring digital entertainment or software subscription',
    };
  }
  if (
    desc.includes('cinema') ||
    desc.includes('movie') ||
    desc.includes('pvr') ||
    desc.includes('inox') ||
    desc.includes('bookmyshow') ||
    desc.includes('concert') ||
    desc.includes('gaming') ||
    desc.includes('steam') ||
    desc.includes('playstation')
  ) {
    return {
      category: 'Entertainment',
      type: 'expense',
      confidence: 0.92,
      reasoning: 'Recreational movie or entertainment expenditure',
    };
  }
  if (
    desc.includes('textbook') ||
    desc.includes('course') ||
    desc.includes('tuition') ||
    desc.includes('college') ||
    desc.includes('university') ||
    desc.includes('udemy') ||
    desc.includes('coursera') ||
    desc.includes('stationery') ||
    desc.includes('exam')
  ) {
    return {
      category: 'Education & Books',
      type: 'expense',
      confidence: 0.95,
      reasoning: 'Academic course materials, textbooks, or fees',
    };
  }
  if (
    desc.includes('pharmacy') ||
    desc.includes('apollo') ||
    desc.includes('pharmeasy') ||
    desc.includes('1mg') ||
    desc.includes('medplus') ||
    desc.includes('doctor') ||
    desc.includes('hospital') ||
    desc.includes('cult.fit') ||
    desc.includes('gym') ||
    desc.includes('fitness')
  ) {
    return {
      category: 'Healthcare & Fitness',
      type: 'expense',
      confidence: 0.93,
      reasoning: 'Healthcare, wellness, or pharmaceutical expenditure',
    };
  }
  if (
    desc.includes('amazon') ||
    desc.includes('flipkart') ||
    desc.includes('myntra') ||
    desc.includes('ajio') ||
    desc.includes('nykaa') ||
    desc.includes('zara') ||
    desc.includes('croma') ||
    desc.includes('electronics') ||
    desc.includes('shoes')
  ) {
    return {
      category: 'Shopping & Personal',
      type: 'expense',
      confidence: 0.91,
      reasoning: 'Retail shopping, apparel, or consumer electronics',
    };
  }

  // Fallback
  return {
    category: defaultType === 'income' ? 'Other Income' : 'Miscellaneous',
    type: defaultType,
    confidence: 0.75,
    reasoning: 'Categorized based on contextual Indian personal finance classification',
  };
}

// 1. Transaction Auto-Categorization Endpoint
// 1. Transaction Auto-Categorization Endpoint
app.post('/api/ai/categorize', async (req: Request, res: Response) => {
  try {
    const { description, amount, currentType, forceRetry } = req.body;

    if (!description || typeof description !== 'string') {
      res.status(400).json({ error: 'Description is required' });
      return;
    }

    // Stop automatic Gemini calls when circuit breaker is OPEN or AI is unconfigured
    if (isCircuitOpen() || !ai) {
      const fallback = heuristicCategorize(description, currentType || 'expense');
      res.json({
        ...fallback,
        source: 'offline-rule-engine',
        isOffline: true,
        isUnavailable: isCircuitOpen(),
        quotaExhausted: isQuotaExhausted,
        quotaMessage: isCircuitOpen() ? FRIENDLY_UNAVAILABLE_MESSAGE : undefined,
      });
      return;
    }

    const prompt = `Analyze this Indian personal finance transaction description: "${description}"${
      amount ? ` for amount ₹${amount}` : ''
    }.
Classify it into the most accurate category and determine whether it represents Income or Expense.

Expense Categories:
- Food & Dining
- Groceries
- Housing & Rent
- Transportation
- Utilities
- Subscriptions
- Entertainment
- Healthcare & Fitness
- Shopping & Personal
- Education & Books
- Travel
- Miscellaneous

Income Categories:
- Salary & Wages
- Freelance & Consulting
- Investments & Dividends
- Gifts & Grants
- Refunds
- Other Income

Provide a confidence score (0.0 to 1.0) and a concise 1-sentence reasoning with Indian merchant context.`;

    const response = await withTimeout(
      ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          systemInstruction:
            'You are an expert Indian financial transaction classification assistant for personal finance systems.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              category: { type: Type.STRING },
              type: { type: Type.STRING, enum: ['income', 'expense'] },
              confidence: { type: Type.NUMBER },
              reasoning: { type: Type.STRING },
            },
            required: ['category', 'type', 'confidence', 'reasoning'],
          },
        },
      }),
      15000
    );

    const parsed = JSON.parse(response.text || '{}');
    if (circuitState !== 'CLOSED') {
      resetCircuit();
    }
    res.json({
      category: parsed.category || 'Miscellaneous',
      type: parsed.type || (currentType || 'expense'),
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.95,
      reasoning: parsed.reasoning || 'Categorized using Gemini 3.8 Flash',
      source: 'gemini-3.8-flash',
      isOffline: false,
      quotaExhausted: false,
    });
  } catch (error: any) {
    if (is429Error(error)) {
      tripCircuit('429_QUOTA', error);
    } else if (is503Error(error)) {
      tripCircuit('503_UNAVAILABLE', error);
    } else if (isTimeoutError(error)) {
      tripCircuit('TIMEOUT', error);
    }
    const fallback = heuristicCategorize(req.body?.description || '', req.body?.currentType || 'expense');
    res.json({
      ...fallback,
      source: 'offline-rule-engine',
      isOffline: true,
      isUnavailable: isCircuitOpen(),
      quotaExhausted: isQuotaExhausted,
      quotaMessage: isCircuitOpen() ? FRIENDLY_UNAVAILABLE_MESSAGE : undefined,
    });
  }
});

// Helper to generate deterministic, high-quality spending insights from actual user transactions
function generateHeuristicSpendingAnalysis(
  transactions: any[],
  totalIncome: number,
  totalExpenses: number
) {
  const expenses = transactions.filter((t) => t.type === 'expense');
  const count = expenses.length;
  const savingsRate =
    totalIncome > 0 ? Math.round(((totalIncome - totalExpenses) / totalIncome) * 100) : 0;

  // Category map
  const catMap: Record<string, number> = {};
  for (const exp of expenses) {
    const c = exp.category || 'Miscellaneous';
    catMap[c] = (catMap[c] || 0) + Number(exp.amount || 0);
  }

  const sorted = Object.entries(catMap).sort((a, b) => b[1] - a[1]);
  const top1 = sorted[0] || ['Living Expenses', 0];
  const top2 = sorted[1] || ['Discretionary', 0];

  const top1Percent = totalExpenses > 0 ? Math.round((top1[1] / totalExpenses) * 100) : 0;
  const top2Percent = totalExpenses > 0 ? Math.round((top2[1] / totalExpenses) * 100) : 0;

  // Needs vs Wants calculation
  const needsCategories = ['Housing & Rent', 'Groceries', 'Utilities', 'Transportation', 'Healthcare & Fitness'];
  const needsTotal = expenses
    .filter((e) => needsCategories.includes(e.category))
    .reduce((s, e) => s + Number(e.amount || 0), 0);

  const wantsTotal = totalExpenses - needsTotal;

  const needsPercentage = totalIncome > 0 ? Math.round((needsTotal / totalIncome) * 100) : 52;
  const wantsPercentage = totalIncome > 0 ? Math.round((wantsTotal / totalIncome) * 100) : 28;
  const actualSavingsPercentage = Math.max(0, savingsRate);

  const healthScore = Math.max(40, Math.min(95, 50 + savingsRate * 0.8));
  const healthStatus =
    savingsRate >= 20 ? 'Optimal' : savingsRate >= 10 ? 'Moderate' : 'Needs Attention';

  return {
    healthScore: Math.round(healthScore),
    healthStatus,
    spendingPatternSummary: `Across ${count} recorded expenses totaling ₹${totalExpenses.toLocaleString(
      'en-IN'
    )}, your primary capital allocation is led by ${top1[0]} at ₹${top1[1].toLocaleString(
      'en-IN'
    )} (${top1Percent}% of total outflows). ${
      top2[1] > 0
        ? `Your secondary spending sector is ${top2[0]} consuming ₹${top2[1].toLocaleString('en-IN')} (${top2Percent}%).`
        : ''
    } With recognized total inflows of ₹${totalIncome.toLocaleString(
      'en-IN'
    )}, you are currently maintaining a ${savingsRate}% monthly savings rate.`,
    keyFindings: [
      {
        category: top1[0],
        observation: `Dominates outflow at ₹${top1[1].toLocaleString(
          'en-IN'
        )} (${top1Percent}% of overall expenses).`,
        impact: 'High',
        actionableInsight: `Review discretionary components within ${top1[0]} to capture immediate surplus.`,
      },
      {
        category: top2[0] !== top1[0] ? top2[0] : 'Discretionary Outflows',
        observation: `Secondary expenditure cluster requiring systematic budgeting.`,
        impact: 'Medium',
        actionableInsight:
          'Utilize UPI payment tracking or batch ordering to reduce impulse transactions.',
      },
      {
        category: 'Fixed Overheads',
        observation: `Living essentials represent ${needsPercentage}% of total inflow.`,
        impact: 'Medium',
        actionableInsight:
          'Maintain an emergency liquidity reserve equal to 3 months of mandatory fixed overheads.',
      },
    ],
    budgetRule503020: {
      needsPercentage: Math.min(85, needsPercentage),
      wantsPercentage: Math.min(60, wantsPercentage),
      savingsPercentage: actualSavingsPercentage,
      idealNeeds: 50,
      idealWants: 30,
      idealSavings: 20,
    },
    smartAlerts: [
      `Your current monthly savings rate is ${savingsRate}%, compared to the 20% benchmark.`,
      `The top category (${top1[0]}) accounts for ${top1Percent}% of your active outflows.`,
      'Consider automating monthly SIP or recurring deposit transfers on the 1st of every month.',
    ],
    source: 'heuristic-resilient',
  };
}

// 2. Spending Analysis Endpoint
app.post('/api/ai/spending-analysis', async (req: Request, res: Response) => {
  let totalIncome = 0;
  let totalExpenses = 0;
  let transactionsCount = 0;

  try {
    const { transactions, summary, forceRetry } = req.body;

    if (!Array.isArray(transactions) || transactions.length === 0) {
      res.status(400).json({ error: 'Valid transactions array is required' });
      return;
    }

    transactionsCount = transactions.length;
    const expenses = transactions.filter((t: any) => t.type === 'expense');
    const income = transactions.filter((t: any) => t.type === 'income');

    totalIncome =
      income.reduce((acc: number, t: any) => acc + Number(t.amount || 0), 0) ||
      Number(summary?.totalIncome || 0);
    totalExpenses =
      expenses.reduce((acc: number, t: any) => acc + Number(t.amount || 0), 0) ||
      Number(summary?.totalExpenses || 0);

    const categoryTotals: Record<string, number> = {};
    for (const exp of expenses) {
      const cat = exp.category || 'Miscellaneous';
      categoryTotals[cat] = (categoryTotals[cat] || 0) + Number(exp.amount || 0);
    }

    // When circuit breaker is OPEN or AI is unconfigured, serve cached AI result or local rule-based recommendations
    if (isCircuitOpen() || !ai) {
      if (cachedAiAnalysis) {
        res.json({
          ...cachedAiAnalysis,
          source: 'cached-ai',
          isOffline: true,
          isUnavailable: isCircuitOpen(),
          quotaExhausted: isQuotaExhausted,
          circuitState,
          quotaMessage: isCircuitOpen() ? FRIENDLY_UNAVAILABLE_MESSAGE : undefined,
        });
        return;
      }
      const heuristic = generateHeuristicSpendingAnalysis(transactions, totalIncome, totalExpenses);
      res.json({
        ...heuristic,
        source: 'offline-rule-engine',
        isOffline: true,
        isUnavailable: isCircuitOpen(),
        quotaExhausted: isQuotaExhausted,
        circuitState,
        quotaMessage: isCircuitOpen() ? FRIENDLY_UNAVAILABLE_MESSAGE : undefined,
      });
      return;
    }

    const sampleSummary = {
      currency: 'INR (₹)',
      totalIncome,
      totalExpenses,
      availableBalance: totalIncome - totalExpenses,
      categoryBreakdown: categoryTotals,
      recentTransactions: transactions.slice(-15).map((t: any) => ({
        description: t.description,
        amount: t.amount,
        category: t.category,
        type: t.type,
        date: t.date,
      })),
    };

    const prompt = `Perform an intelligent financial spending analysis on this user's Indian personal finance ledger (values in INR ₹):
${JSON.stringify(sampleSummary, null, 2)}

Provide:
1. Overall Financial Health Score (integer 0 to 100).
2. Health status string ('Optimal', 'Moderate', or 'Needs Attention').
3. A concise, data-driven spending pattern summary (2-3 paragraphs analyzing needs vs wants, discretionary leaks, and savings velocity in Indian Rupee terms).
4. Key findings (3-4 items) detailing specific category behaviors with impact level ('High', 'Medium', 'Low') and actionable insights.
5. 50/30/20 budget framework analysis estimating actual Needs %, Wants %, and Savings % based on categories.
6. Smart alerts (2-3 items) warning of spikes or positive milestones.`;

    const response = await withTimeout(
      ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          systemInstruction:
            'You are a Senior AI Financial Analyst specializing in personal finance. All monetary figures must be in Indian Rupees (₹). Provide objective, encouraging, and actionable insights. Do not give certified legal or investment advice.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              healthScore: { type: Type.INTEGER },
              healthStatus: { type: Type.STRING },
              spendingPatternSummary: { type: Type.STRING },
              keyFindings: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    category: { type: Type.STRING },
                    observation: { type: Type.STRING },
                    impact: { type: Type.STRING },
                    actionableInsight: { type: Type.STRING },
                  },
                  required: ['category', 'observation', 'impact', 'actionableInsight'],
                },
              },
              budgetRule503020: {
                type: Type.OBJECT,
                properties: {
                  needsPercentage: { type: Type.NUMBER },
                  wantsPercentage: { type: Type.NUMBER },
                  savingsPercentage: { type: Type.NUMBER },
                  idealNeeds: { type: Type.NUMBER },
                  idealWants: { type: Type.NUMBER },
                  idealSavings: { type: Type.NUMBER },
                },
                required: [
                  'needsPercentage',
                  'wantsPercentage',
                  'savingsPercentage',
                  'idealNeeds',
                  'idealWants',
                  'idealSavings',
                ],
              },
              smartAlerts: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
            },
            required: [
              'healthScore',
              'healthStatus',
              'spendingPatternSummary',
              'keyFindings',
              'budgetRule503020',
              'smartAlerts',
            ],
          },
        },
      }),
      20000
    );

    const parsed = JSON.parse(response.text || '{}');
    cachedAiAnalysis = parsed;
    if (circuitState !== 'CLOSED') {
      resetCircuit();
    }

    res.json({
      ...parsed,
      source: 'gemini-3.8-flash',
      isOffline: false,
      quotaExhausted: false,
    });
  } catch (error: any) {
    if (is429Error(error)) {
      tripCircuit('429_QUOTA', error);
    } else if (is503Error(error)) {
      tripCircuit('503_UNAVAILABLE', error);
    } else if (isTimeoutError(error)) {
      tripCircuit('TIMEOUT', error);
    } else {
      tripCircuit('503_UNAVAILABLE', error);
    }

    if (cachedAiAnalysis) {
      res.json({
        ...cachedAiAnalysis,
        source: 'cached-ai',
        isOffline: true,
        isUnavailable: isCircuitOpen(),
        quotaExhausted: isQuotaExhausted,
        circuitState,
        quotaMessage: isCircuitOpen() ? FRIENDLY_UNAVAILABLE_MESSAGE : undefined,
      });
      return;
    }

    const fallback = generateHeuristicSpendingAnalysis(
      req.body?.transactions || [],
      totalIncome,
      totalExpenses
    );
    res.json({
      ...fallback,
      source: 'offline-rule-engine',
      isOffline: true,
      isUnavailable: isCircuitOpen(),
      quotaExhausted: isQuotaExhausted,
      circuitState,
      quotaMessage: isCircuitOpen() ? FRIENDLY_UNAVAILABLE_MESSAGE : undefined,
    });
  }
});

// Helper to generate tailored, non-zero savings recommendations in INR
function generateHeuristicSavingRecommendations(transactions: any[], totalIncome: number, totalExpenses: number) {
  const expenses = transactions.filter((t: any) => t.type === 'expense');
  const catTotals: Record<string, number> = {};
  for (const e of expenses) {
    const c = e.category || 'Miscellaneous';
    catTotals[c] = (catTotals[c] || 0) + Number(e.amount || 0);
  }

  const recommendations = [
    {
      id: 'rec-1',
      title: 'Optimize Dining & Food Delivery (Swiggy / Zomato)',
      description:
        'Meal-prep weeknight dinners and brew your morning coffee at home to trim dining and delivery surge fees.',
      category: 'Food & Dining',
      potentialMonthlySavings: Math.max(1200, Math.round((catTotals['Food & Dining'] || 4000) * 0.35)),
      difficulty: 'Easy' as const,
      impact: 'High' as const,
      actionSteps: [
        'Limit food delivery orders to twice a week',
        'Prepare simple batch lunches on Sundays to carry to campus or work',
      ],
    },
    {
      id: 'rec-2',
      title: 'Audit Recurring Digital Subscriptions',
      description:
        'Review streaming platforms (Netflix, Hotstar, Spotify) and cancel or pause services not used in the past 14 days.',
      category: 'Subscriptions',
      potentialMonthlySavings: Math.max(450, Math.round((catTotals['Subscriptions'] || 1200) * 0.4)),
      difficulty: 'Easy' as const,
      impact: 'Medium' as const,
      actionSteps: [
        'Check bank and UPI autopay statements for forgotten recurring subscriptions',
        'Share family or annual subscription plans to split costs with roommates',
      ],
    },
    {
      id: 'rec-3',
      title: 'Commute & Rideshare Rationalization',
      description:
        'Utilize metro rail smart cards or city bus passes instead of booking peak-hour on-demand cabs or auto rides.',
      category: 'Transportation',
      potentialMonthlySavings: Math.max(900, Math.round((catTotals['Transportation'] || 3000) * 0.3)),
      difficulty: 'Medium' as const,
      impact: 'Medium' as const,
      actionSteps: [
        'Use metro smart cards or monthly commuter passes for routine travel',
        'Carpool or use shuttle services for campus and office commutes',
      ],
    },
    {
      id: 'rec-4',
      title: 'Bulk Grocery Planning & Quick-Commerce Control',
      description:
        'Replace multiple small quick-commerce orders with planned weekly wholesale or local market purchases.',
      category: 'Groceries',
      potentialMonthlySavings: Math.max(800, Math.round((catTotals['Groceries'] || 6000) * 0.18)),
      difficulty: 'Easy' as const,
      impact: 'Medium' as const,
      actionSteps: [
        'Create a pre-shopping grocery checklist before opening ordering apps',
        'Buy non-perishable pantry staples in bulk to avoid frequent handling fees',
      ],
    },
  ];

  const totalMonthly = recommendations.reduce((s, r) => s + r.potentialMonthlySavings, 0);

  return {
    projectedMonthlySavings: totalMonthly,
    projectedAnnualSavings: totalMonthly * 12,
    recommendations,
    habitChallenge: {
      title: 'The 7-Day Zero-Delivery Challenge',
      duration: '7 Days',
      objective:
        'Cook dinner at home and brew your own tea/coffee for one full week to build lasting financial resilience.',
      estimatedSavings: 1500,
    },
    educationalNotice:
      'This recommendation report is generated by an educational AI simulation for college project demonstration purposes and does not constitute certified financial advisory services.',
    source: 'heuristic-resilient',
  };
}

// 3. Saving Recommendations Endpoint
app.post('/api/ai/recommendations', async (req: Request, res: Response) => {
  let totalIncome = 0;
  let totalExpenses = 0;

  try {
    const { transactions, metrics, forceRetry } = req.body;

    if (!Array.isArray(transactions) || transactions.length === 0) {
      res.status(400).json({ error: 'Valid transactions array is required' });
      return;
    }

    const expenses = transactions.filter((t: any) => t.type === 'expense');
    const income = transactions.filter((t: any) => t.type === 'income');
    totalExpenses = expenses.reduce((acc: number, t: any) => acc + Number(t.amount || 0), 0);
    totalIncome = income.reduce((acc: number, t: any) => acc + Number(t.amount || 0), 0);

    // When circuit breaker is OPEN or AI is unconfigured, serve cached AI result or local rule-based recommendations
    if (isCircuitOpen() || !ai) {
      if (cachedAiRecommendations) {
        res.json({
          ...cachedAiRecommendations,
          source: 'cached-ai',
          isOffline: true,
          isUnavailable: isCircuitOpen(),
          quotaExhausted: isQuotaExhausted,
          circuitState,
          quotaMessage: isCircuitOpen() ? FRIENDLY_UNAVAILABLE_MESSAGE : undefined,
        });
        return;
      }
      const fallback = generateHeuristicSavingRecommendations(transactions, totalIncome, totalExpenses);
      res.json({
        ...fallback,
        source: 'offline-rule-engine',
        isOffline: true,
        isUnavailable: isCircuitOpen(),
        quotaExhausted: isQuotaExhausted,
        circuitState,
        quotaMessage: isCircuitOpen() ? FRIENDLY_UNAVAILABLE_MESSAGE : undefined,
      });
      return;
    }

    const payload = {
      currency: 'INR (₹)',
      totalIncome,
      totalExpenses,
      monthlySavings: totalIncome - totalExpenses,
      recentExpenses: expenses.slice(-20).map((t: any) => ({
        description: t.description,
        amount: t.amount,
        category: t.category,
        date: t.date,
      })),
      metrics,
    };

    const prompt = `Analyze this Indian personal finance portfolio and generate 3 to 4 hyper-practical, highly realistic AI saving recommendations in Indian Rupees (₹).
${JSON.stringify(payload, null, 2)}

Requirements:
- Recommendations must be practical for young professionals / college students in India.
- Provide realistic monthly rupee savings (potentialMonthlySavings as an integer in ₹, e.g. ₹500 to ₹3,500).
- Calculate total projected monthly savings and projected annual savings in ₹.
- Include a tailored 7-Day or 14-Day Micro-Habit Financial Challenge with estimated savings in ₹.
- Include an educational disclaimer stating this is an AI for Finance project demonstration.`;

    const response = await withTimeout(
      ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          systemInstruction:
            'You are a warm, pragmatic financial coach AI specializing in Indian personal finance. All values are in Indian Rupees (₹). Provide specific, tactful, and empowering saving strategies.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              projectedMonthlySavings: { type: Type.NUMBER },
              projectedAnnualSavings: { type: Type.NUMBER },
              recommendations: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    title: { type: Type.STRING },
                    description: { type: Type.STRING },
                    category: { type: Type.STRING },
                    potentialMonthlySavings: { type: Type.NUMBER },
                    difficulty: { type: Type.STRING, enum: ['Easy', 'Medium', 'Challenging'] },
                    impact: { type: Type.STRING, enum: ['High', 'Medium', 'Low'] },
                    actionSteps: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                    },
                  },
                  required: [
                    'id',
                    'title',
                    'description',
                    'category',
                    'potentialMonthlySavings',
                    'difficulty',
                    'impact',
                    'actionSteps',
                  ],
                },
              },
              habitChallenge: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  duration: { type: Type.STRING },
                  objective: { type: Type.STRING },
                  estimatedSavings: { type: Type.NUMBER },
                },
                required: ['title', 'duration', 'objective', 'estimatedSavings'],
              },
              educationalNotice: { type: Type.STRING },
            },
            required: [
              'projectedMonthlySavings',
              'projectedAnnualSavings',
              'recommendations',
              'habitChallenge',
              'educationalNotice',
            ],
          },
        },
      }),
      20000
    );

    const parsed = JSON.parse(response.text || '{}');
    cachedAiRecommendations = parsed;
    if (circuitState !== 'CLOSED') {
      resetCircuit();
    }

    res.json({
      ...parsed,
      source: 'gemini-3.8-flash',
      isOffline: false,
      quotaExhausted: false,
    });
  } catch (error: any) {
    if (is429Error(error)) {
      tripCircuit('429_QUOTA', error);
    } else if (is503Error(error)) {
      tripCircuit('503_UNAVAILABLE', error);
    } else if (isTimeoutError(error)) {
      tripCircuit('TIMEOUT', error);
    } else {
      tripCircuit('503_UNAVAILABLE', error);
    }

    if (cachedAiRecommendations) {
      res.json({
        ...cachedAiRecommendations,
        source: 'cached-ai',
        isOffline: true,
        isUnavailable: isCircuitOpen(),
        quotaExhausted: isQuotaExhausted,
        circuitState,
        quotaMessage: isCircuitOpen() ? FRIENDLY_UNAVAILABLE_MESSAGE : undefined,
      });
      return;
    }

    const fallback = generateHeuristicSavingRecommendations(
      req.body?.transactions || [],
      totalIncome,
      totalExpenses
    );
    res.json({
      ...fallback,
      source: 'offline-rule-engine',
      isOffline: true,
      isUnavailable: isCircuitOpen(),
      quotaExhausted: isQuotaExhausted,
      circuitState,
      quotaMessage: isCircuitOpen() ? FRIENDLY_UNAVAILABLE_MESSAGE : undefined,
    });
  }
});

// Vite middleware in dev or static files in production
async function setupVite() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

setupVite().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
