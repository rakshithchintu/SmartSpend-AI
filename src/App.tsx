import React, { useState, useEffect, useMemo } from 'react';
import {
  Sparkles,
  Plus,
  ArrowRight,
  TrendingUp,
  ShieldCheck,
  PiggyBank,
  GraduationCap,
  ArrowUpRight,
  ArrowDownRight,
  Calendar,
  Layers,
  WifiOff,
  RefreshCw,
} from 'lucide-react';
import { Transaction } from './types/finance';
import {
  loadTransactions,
  saveTransactions,
  resetToSampleTransactions,
  exportTransactionsBackupJSON,
  parseTransactionsBackupJSON,
  mergeTransactionCollections,
} from './utils/storage';
import { formatCurrency, formatDate } from './utils/formatters';
import {
  getIsQuotaExhausted,
  setIsQuotaExhausted,
  resetCircuitBreaker,
  FRIENDLY_UNAVAILABLE_MESSAGE,
  QUOTA_EXHAUSTED_MESSAGE,
  CIRCUIT_BREAKER_CHANGED_EVENT,
  QUOTA_CHANGED_EVENT,
} from './utils/aiQuota';
import { Navbar, ActiveTab } from './components/Navbar';
import { MetricCards } from './components/MetricCards';
import { CashFlowChart } from './components/CashFlowChart';
import { CategoryDonutChart } from './components/CategoryDonutChart';
import { TransactionModal } from './components/TransactionModal';
import { TransactionHistory } from './components/TransactionHistory';
import { SpendingAnalysis } from './components/SpendingAnalysis';
import { SavingRecommendations } from './components/SavingRecommendations';
import { ToastContainer, ToastMessage } from './components/Toast';

export default function App() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [activeTab, setActiveTab] = useState<ActiveTab>('dashboard');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [isQuotaExhausted, setIsQuotaExhaustedState] = useState<boolean>(getIsQuotaExhausted());

  // Initialize transactions and sync quota state from server
  useEffect(() => {
    const initialData = loadTransactions();
    setTransactions(initialData);

    // Sync quota status with server
    fetch('/api/ai/quota-status')
      .then((res) => res.json())
      .then((data) => {
        if (data?.isQuotaExhausted) {
          setIsQuotaExhausted(true);
          setIsQuotaExhaustedState(true);
        }
      })
      .catch(() => {});

    // Listen for client-side circuit breaker and quota changes
    const handleStatusChange = (e: any) => {
      setIsQuotaExhaustedState(getIsQuotaExhausted());
    };
    window.addEventListener(CIRCUIT_BREAKER_CHANGED_EVENT, handleStatusChange);
    window.addEventListener(QUOTA_CHANGED_EVENT, handleStatusChange);
    return () => {
      window.removeEventListener(CIRCUIT_BREAKER_CHANGED_EVENT, handleStatusChange);
      window.removeEventListener(QUOTA_CHANGED_EVENT, handleStatusChange);
    };
  }, []);

  const addToast = (type: 'success' | 'error' | 'info', message: string, description?: string) => {
    const id = Date.now().toString() + Math.random().toString(36).substring(2, 6);
    setToasts((prev) => [...prev, { id, type, message, description }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  };

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  // Financial calculations
  const totalIncome = useMemo(() => {
    return transactions
      .filter((t) => t.type === 'income')
      .reduce((sum, t) => sum + Number(t.amount), 0);
  }, [transactions]);

  const totalExpenses = useMemo(() => {
    return transactions
      .filter((t) => t.type === 'expense')
      .reduce((sum, t) => sum + Number(t.amount), 0);
  }, [transactions]);

  const availableBalance = totalIncome - totalExpenses;
  const monthlySavings = availableBalance;
  const savingsRate = totalIncome > 0 ? Math.round((monthlySavings / totalIncome) * 100) : 0;

  // Handle save transaction (Add or Edit)
  const handleSaveTransaction = (
    data: Omit<Transaction, 'id' | 'createdAt'>,
    existingId?: string
  ) => {
    if (existingId) {
      // Edit
      const updated = transactions.map((t) =>
        t.id === existingId
          ? {
              ...t,
              ...data,
            }
          : t
      );
      setTransactions(updated);
      saveTransactions(updated);
      addToast(
        'success',
        'Transaction Updated',
        `"${data.description}" for ${formatCurrency(data.amount)} was updated.`
      );
    } else {
      // Add new
      const newTx: Transaction = {
        ...data,
        id: `tx-${Date.now()}`,
        createdAt: Date.now(),
      };
      const updated = [newTx, ...transactions];
      setTransactions(updated);
      saveTransactions(updated);
      addToast(
        'success',
        'Transaction Recorded',
        `${data.type === 'income' ? 'Inflow' : 'Expense'} of ${formatCurrency(data.amount)} added under ${data.category}.`
      );
    }
  };

  // Handle delete
  const handleDeleteTransaction = (id: string) => {
    const target = transactions.find((t) => t.id === id);
    const updated = transactions.filter((t) => t.id !== id);
    setTransactions(updated);
    saveTransactions(updated);
    addToast(
      'info',
      'Transaction Removed',
      target ? `Removed "${target.description}"` : 'Transaction removed from ledger.'
    );
  };

  // Reset to college demo sample data
  const handleResetData = () => {
    const reset = resetToSampleTransactions();
    setTransactions(reset);
    addToast(
      'info',
      'Demo Dataset Restored',
      'Reset all ledger records back to the 18 sample transactions for demonstration.'
    );
  };

  // Export CSV
  const handleExportCSV = () => {
    if (transactions.length === 0) {
      addToast('error', 'No Data to Export', 'Record some transactions before exporting.');
      return;
    }

    const headers = ['ID', 'Date', 'Description', 'Type', 'Category', 'Amount', 'Notes', 'AICategorized'];
    const rows = transactions.map((t) => [
      t.id,
      t.date,
      `"${t.description.replace(/"/g, '""')}"`,
      t.type,
      `"${t.category}"`,
      t.amount.toFixed(2),
      `"${(t.notes || '').replace(/"/g, '""')}"`,
      t.aiCategorized ? 'true' : 'false',
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `SmartSpend_Ledger_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    addToast('success', 'CSV Exported', 'Your ledger has been downloaded successfully.');
  };

  // Export JSON Backup
  const handleExportJSON = () => {
    if (transactions.length === 0) {
      addToast('error', 'No Data to Backup', 'Record or import some transactions before backing up.');
      return;
    }
    try {
      exportTransactionsBackupJSON(transactions);
      addToast(
        'success',
        'JSON Backup Downloaded',
        `Exported full ledger with ${transactions.length} records.`
      );
    } catch {
      addToast('error', 'Export Failed', 'Could not create JSON backup file.');
    }
  };

  // Import JSON Backup
  const handleImportJSON = async (file: File) => {
    try {
      const { importedTransactions, count } = await parseTransactionsBackupJSON(file);
      // Safely merge with existing transactions so existing user data is preserved
      const merged = mergeTransactionCollections(importedTransactions, transactions);
      setTransactions(merged);
      saveTransactions(merged);
      addToast(
        'success',
        'JSON Backup Restored',
        `Successfully imported ${count} transactions. Total ledger now contains ${merged.length} items.`
      );
    } catch (err: any) {
      console.error('Import error:', err);
      addToast('error', 'Import Failed', err?.message || 'Could not parse JSON backup file.');
    }
  };

  // Open modal for add
  const handleOpenAddModal = () => {
    setEditingTransaction(null);
    setIsModalOpen(true);
  };

  // Open modal for edit
  const handleOpenEditModal = (tx: Transaction) => {
    setEditingTransaction(tx);
    setIsModalOpen(true);
  };

  // 5 most recent transactions for dashboard preview
  const recentTransactions = useMemo(() => {
    return [...transactions]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 5);
  }, [transactions]);

  // Reset circuit breaker and quota state manually
  const handleResetQuota = async () => {
    try {
      await fetch('/api/ai/reset-circuit', { method: 'POST' });
    } catch {
      // Local fallback
    }
    resetCircuitBreaker();
    setIsQuotaExhaustedState(false);
    addToast('info', 'Live AI Re-enabled', 'Gemini API requests have been resumed.');
  };

  return (
    <div className="min-h-screen bg-[#070b14] text-slate-100 flex flex-col font-sans">
      {/* Background ambient lighting */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div className="absolute -top-40 left-1/4 w-[600px] h-[600px] bg-purple-900/15 rounded-full blur-[140px]" />
        <div className="absolute top-1/3 -right-40 w-[500px] h-[500px] bg-indigo-900/15 rounded-full blur-[140px]" />
        <div className="absolute bottom-10 left-10 w-[400px] h-[400px] bg-blue-900/10 rounded-full blur-[120px]" />
      </div>

      {/* Main Top Navigation */}
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onOpenNewTransaction={handleOpenAddModal}
        onResetData={handleResetData}
        transactionCount={transactions.length}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 relative z-10 space-y-6">
        {/* Global Visible Gemini Daily Quota Limit Banner (Requirement 10) */}
        {isQuotaExhausted && (
          <div className="p-4 rounded-2xl bg-amber-950/40 border border-amber-500/40 text-amber-200 shadow-xl shadow-amber-950/20 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 animate-in fade-in">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-amber-500/20 border border-amber-500/30 flex items-center justify-center shrink-0">
                <WifiOff className="w-4 h-4 text-amber-400" />
              </div>
              <div>
                <div className="font-bold text-white text-xs sm:text-sm">
                  Gemini AI is temporarily unavailable. Offline analysis is active.
                </div>
                <p className="text-[11px] text-amber-300/80 mt-0.5">
                  Automated Gemini API requests paused to prevent rate and service errors. Intelligent offline rules engine active with zero data loss.
                </p>
              </div>
            </div>
            <button
              onClick={handleResetQuota}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold text-amber-100 bg-amber-900/60 hover:bg-amber-800/80 border border-amber-500/40 rounded-xl transition-all shrink-0 hover:text-white"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Retry Gemini AI</span>
            </button>
          </div>
        )}

        {/* Academic Project Kicker Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-2 border-b border-slate-800/60">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="font-semibold text-purple-400 flex items-center gap-1">
              <Sparkles className="w-3.5 h-3.5 text-purple-400" />
              SmartSpend AI Platform
            </span>
            <span aria-hidden="true" className="text-slate-600">·</span>
            <span>AI for Finance Assignment Project</span>
            <span aria-hidden="true" className="text-slate-600">·</span>
            <span className="font-mono text-slate-400">v2.4 Active</span>
          </div>

          <div className="flex items-center gap-2">
            <span className="px-2.5 py-1 text-[11px] font-medium rounded-lg bg-slate-900 border border-slate-800 text-slate-300">
              Active Ledger: <strong className="text-white font-mono">{transactions.length}</strong> Entries
            </span>
          </div>
        </div>

        {/* TAB 1: DASHBOARD OVERVIEW */}
        {activeTab === 'dashboard' && (
          <div className="space-y-6">
            {/* Metric KPI Cards */}
            <MetricCards
              totalIncome={totalIncome}
              totalExpenses={totalExpenses}
              availableBalance={availableBalance}
              monthlySavings={monthlySavings}
              savingsRate={savingsRate}
              onOpenAnalysis={() => setActiveTab('analytics')}
            />

            {/* Visual Charts: Cash Flow & Category Breakdown */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-7">
                <CashFlowChart transactions={transactions} />
              </div>
              <div className="lg:col-span-5">
                <CategoryDonutChart
                  transactions={transactions}
                  onSelectCategory={() => setActiveTab('transactions')}
                />
              </div>
            </div>

            {/* Teaser Banners: AI Spending Insights & Recommendations */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Teaser 1: AI Analysis */}
              <div className="rounded-2xl bg-gradient-to-br from-[#0c1220]/90 via-[#10162a]/90 to-[#181232]/80 border border-purple-500/30 p-5 shadow-lg shadow-purple-950/20 flex flex-col justify-between group hover:border-purple-400/50 transition-all">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-purple-400">
                      AI Spending Intelligence
                    </span>
                    <ShieldCheck className="w-4 h-4 text-purple-400" />
                  </div>
                  <h3 className="text-base font-bold text-white tracking-tight">
                    Analyze Patterns & 50/30/20 Adherence
                  </h3>
                  <p className="text-xs text-slate-300 mt-1.5 leading-relaxed">
                    Evaluate your spending velocity against the classical 50/30/20 rule, identify category leaks, and inspect behavioral alerts.
                  </p>
                </div>
                <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between">
                  <span className="text-xs text-slate-400 font-mono">
                    {transactions.filter((t) => t.type === 'expense').length} expense transactions profiled
                  </span>
                  <button
                    onClick={() => setActiveTab('analytics')}
                    className="inline-flex items-center gap-1 text-xs font-bold text-purple-400 hover:text-purple-300 transition-colors"
                  >
                    <span>View Analysis</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Teaser 2: AI Saving Tips */}
              <div className="rounded-2xl bg-gradient-to-br from-[#0c1220]/90 via-[#121629]/90 to-[#0e1d2e]/80 border border-indigo-500/30 p-5 shadow-lg shadow-indigo-950/20 flex flex-col justify-between group hover:border-indigo-400/50 transition-all">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-indigo-400">
                      AI Saving Engine
                    </span>
                    <PiggyBank className="w-4 h-4 text-emerald-400" />
                  </div>
                  <h3 className="text-base font-bold text-white tracking-tight">
                    Personalized Saving Strategies & Action Plans
                  </h3>
                  <p className="text-xs text-slate-300 mt-1.5 leading-relaxed">
                    Gemini AI synthesizes hyper-specific cutbacks, sets micro-habit challenges, and computes projected annual savings.
                  </p>
                </div>
                <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between">
                  <span className="text-xs text-slate-400 font-mono">
                    Est. savings potential: +₹4,500/mo
                  </span>
                  <button
                    onClick={() => setActiveTab('recommendations')}
                    className="inline-flex items-center gap-1 text-xs font-bold text-indigo-400 hover:text-indigo-300 transition-colors"
                  >
                    <span>Explore Tips</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>

            {/* Recent Transactions Snippet */}
            <div className="rounded-2xl bg-[#0c1220]/90 border border-slate-800/80 shadow-lg shadow-black/20 overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-800/80 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-white tracking-tight">Recent Activity Feed</h3>
                  <p className="text-xs text-slate-400 mt-0.5">Latest recorded cash inflows and outflows</p>
                </div>
                <button
                  onClick={() => setActiveTab('transactions')}
                  className="text-xs font-semibold text-purple-400 hover:text-purple-300 flex items-center gap-1 transition-colors"
                >
                  <span>View All Ledger ({transactions.length})</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="divide-y divide-slate-800/60">
                {recentTransactions.map((tx) => (
                  <div
                    key={tx.id}
                    onClick={() => handleOpenEditModal(tx)}
                    className="px-5 py-3.5 flex items-center justify-between hover:bg-slate-800/40 cursor-pointer transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                          tx.type === 'income'
                            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                            : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                        }`}
                      >
                        {tx.type === 'income' ? (
                          <ArrowUpRight className="w-3.5 h-3.5" />
                        ) : (
                          <ArrowDownRight className="w-3.5 h-3.5" />
                        )}
                      </div>
                      <div>
                        <div className="font-semibold text-white text-xs tracking-tight">
                          {tx.description}
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-slate-400 mt-0.5">
                          <span>{tx.category}</span>
                          <span aria-hidden="true">·</span>
                          <span>{formatDate(tx.date)}</span>
                          {tx.aiCategorized && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-purple-400 flex items-center gap-0.5">
                                <Sparkles className="w-2.5 h-2.5" /> AI
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="text-right font-mono tabular-nums font-bold text-sm">
                      <span className={tx.type === 'income' ? 'text-emerald-400' : 'text-slate-100'}>
                        {tx.type === 'income' ? '+' : '-'}
                        {formatCurrency(tx.amount)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: TRANSACTIONS LEDGER */}
        {activeTab === 'transactions' && (
          <TransactionHistory
            transactions={transactions}
            onEdit={handleOpenEditModal}
            onDelete={handleDeleteTransaction}
            onAddNew={handleOpenAddModal}
            onExportCSV={handleExportCSV}
            onExportJSON={handleExportJSON}
            onImportJSON={handleImportJSON}
          />
        )}

        {/* TAB 3: AI SPENDING ANALYSIS */}
        {activeTab === 'analytics' && (
          <SpendingAnalysis
            transactions={transactions}
            totalIncome={totalIncome}
            totalExpenses={totalExpenses}
          />
        )}

        {/* TAB 4: AI SAVING RECOMMENDATIONS */}
        {activeTab === 'recommendations' && (
          <SavingRecommendations
            transactions={transactions}
            totalIncome={totalIncome}
            totalExpenses={totalExpenses}
            monthlySavings={monthlySavings}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t border-slate-800/80 bg-[#070b14] py-6 relative z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-300">SmartSpend AI</span>
            <span>·</span>
            <span>Personal Finance Management System</span>
            <span>·</span>
            <span className="text-purple-400">AI for Finance Project</span>
          </div>
          <div>
            Powered by Google Gemini 3.8 Flash & Full-Stack React Architecture
          </div>
        </div>
      </footer>

      {/* Add / Edit Transaction Modal */}
      <TransactionModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSave={handleSaveTransaction}
        editingTransaction={editingTransaction}
      />

      {/* Toast Notification Container */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
