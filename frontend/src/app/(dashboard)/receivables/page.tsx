'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';
import {
  HandCoins, X, Calendar, Settings as SettingsIcon, Plus, Minus, ArrowLeftRight,
  Wallet, Landmark, Smartphone, Ban,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';

import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore } from '@/store/pos-settings';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatDate } from '@/hooks/useFormatDate';
import { getCurrencyMinorUnitFactor } from '@/lib/countries';

type Tab = 'summary' | 'movements' | 'receivable' | 'payable';
type AgeBucket = 'current' | 'week' | 'month' | 'overdue';

interface Account {
  id: number;
  name: string;
  kind: 'cash' | 'bank' | 'digital';
  canonical_method: string | null;
  payment_method_id: number | null;
  balance_cents: number;
  inflow_cents: number;
  outflow_cents: number;
}

interface ReceivableRow {
  bill_id: number; bill_number: string; customer_id: string; customer_name: string;
  customer_phone: string | null; total: number; paid_amount: number; balance: number;
  created_at: string; due_date: string | null; notes: string | null;
  age_bucket: AgeBucket; days_overdue: number;
}

interface PayableRow {
  source: 'purchase' | 'general'; id: number; number: string; payee: string;
  reference: string | null; concept: string; total_cents: number; paid_cents: number;
  balance_cents: number; due_date: string; age_bucket: AgeBucket; days_overdue: number;
}

interface MovementRow {
  id: string; occurred_at: string; account_name: string | null;
  type: 'collection' | 'income' | 'expense' | 'supplier_payment' | 'payable_payment' | 'transfer';
  concept: string; counterparty: string | null; reference: string | null;
  in_cents: number; out_cents: number; voided: boolean;
}

interface Summary {
  accounts: Account[];
  available: { total_cents: number; cash_cents: number; bank_cents: number };
  receivables: { total_cents: number; overdue_cents: number; customer_count: number; buckets: Record<AgeBucket, number> };
  payables: { total_cents: number; overdue_cents: number; payee_count: number; buckets: Record<AgeBucket, number>; covered_by_cash: boolean };
  today: { inflow_cents: number; outflow_cents: number; net_cents: number };
  net_position_cents: number;
  projection: { days: number; incoming_cents: number; outgoing_cents: number; net_cents: number; projected_cash_cents: number }[];
  collections_today: { bill_number: string; at: string; customer_name: string | null; account_name: string; amount_cents: number }[];
  register: { open: boolean; business_date: string; opening_float_cents: number; cash_in_cents: number; cash_out_cents: number; expected_cash_cents: number };
}

const AGE_STYLE: Record<AgeBucket, string> = {
  current: 'bg-gray-100 text-gray-600 dark:bg-muted dark:text-muted-foreground',
  week: 'bg-amber-100 text-amber-800',
  month: 'bg-orange-100 text-orange-800',
  overdue: 'bg-red-100 text-red-800',
};

const BUCKET_BAR: Record<AgeBucket, string> = {
  current: 'bg-gray-400', week: 'bg-amber-400', month: 'bg-orange-500', overdue: 'bg-red-500',
};

const TYPE_STYLE: Record<MovementRow['type'], string> = {
  collection: 'bg-green-100 text-green-800',
  income: 'bg-green-100 text-green-800',
  expense: 'bg-red-100 text-red-800',
  supplier_payment: 'bg-orange-100 text-orange-800',
  payable_payment: 'bg-orange-100 text-orange-800',
  transfer: 'bg-blue-100 text-blue-800',
};

const ACCOUNT_ICON = { cash: Wallet, bank: Landmark, digital: Smartphone };

export default function CarteraPage() {
  const t = useTranslations('receivables');
  const tCommon = useTranslations('common');
  const { currentTenant } = useAuthStore();
  const modules = usePosSettingsStore((s) => s.modules);
  const fmt = useFormatCurrency();
  const { formatDate } = useFormatDate();
  const factor = getCurrencyMinorUnitFactor(currentTenant?.currency || 'INR');

  const [tab, setTab] = useState<Tab>('summary');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [receivables, setReceivables] = useState<ReceivableRow[]>([]);
  const [payables, setPayables] = useState<PayableRow[]>([]);
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [saving, setSaving] = useState(false);

  const [search, setSearch] = useState('');
  const [accountFilter, setAccountFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');

  const [collectTarget, setCollectTarget] = useState<ReceivableRow | null>(null);
  const [payTarget, setPayTarget] = useState<PayableRow | null>(null);
  const [amountForm, setAmountForm] = useState({ account_id: 0, amount: '' });
  const [termsTarget, setTermsTarget] = useState<ReceivableRow | null>(null);
  const [termsForm, setTermsForm] = useState({ due_date: '', notes: '' });
  const [entryForm, setEntryForm] = useState<{ kind: 'income' | 'expense'; account_id: number; amount: string; concept: string } | null>(null);
  const [transferForm, setTransferForm] = useState<{ from: number; to: number; amount: string; concept: string } | null>(null);
  const [payableForm, setPayableForm] = useState<{ payee_name: string; concept: string; amount: string; due_date: string; reference: string } | null>(null);
  const [voidTarget, setVoidTarget] = useState<MovementRow | null>(null);
  const [voidReason, setVoidReason] = useState('');

  const moduleOn = modules?.receivables;

  // Devuelve los datos en vez de asignarlos: quien llama decide si el
  // componente sigue montado, y el efecto no toca el estado de forma síncrona.
  const load = useCallback(async () => {
    const [s, r, p, m, a] = await Promise.all([
      api.get('/cartera/summary'),
      api.get('/receivables'),
      api.get('/cartera/payables'),
      api.get('/cartera/movements'),
      api.get('/cartera/accounts'),
    ]);
    return {
      summary: s.data as Summary,
      receivables: (r.data.receivables || []) as ReceivableRow[],
      payables: (p.data.payables || []) as PayableRow[],
      movements: (m.data.movements || []) as MovementRow[],
      accounts: (a.data.accounts || []) as Account[],
    };
  }, []);

  useEffect(() => {
    if (!moduleOn) return;
    let active = true;
    load()
      .then((data) => {
        if (!active) return;
        setSummary(data.summary);
        setReceivables(data.receivables);
        setPayables(data.payables);
        setMovements(data.movements);
        setAccounts(data.accounts);
      })
      .catch(() => { if (active) toast.error(t('loadFailed')); });
    return () => { active = false; };
  }, [moduleOn, refreshKey, load, t]);

  const refresh = () => setRefreshKey((key) => key + 1);
  const cents = (value: string) => Math.round(Number(value) * factor);
  const ageLabel = useMemo(() => ({
    current: t('ageCurrent'), week: t('ageWeek'), month: t('ageMonth'), overdue: t('ageOverdue'),
  }), [t]);
  const typeLabel = useMemo(() => ({
    collection: t('typeCollection'), income: t('typeIncome'), expense: t('typeExpense'),
    supplier_payment: t('typeSupplierPayment'), payable_payment: t('typePayablePayment'), transfer: t('typeTransfer'),
  }), [t]);

  const withSaving = async (action: () => Promise<void>) => {
    setSaving(true);
    try {
      await action();
      refresh();
    } catch (error: unknown) {
      const message = (error as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(message || tCommon('somethingWrong'));
    } finally {
      setSaving(false);
    }
  };

  const collect = (event: React.FormEvent) => {
    event.preventDefault();
    if (!collectTarget) return;
    const account = accounts.find((a) => a.id === amountForm.account_id);
    if (!account) return;
    void withSaving(async () => {
      await api.post(`/bills/${collectTarget.bill_id}/payment`, {
        method: account.canonical_method || 'custom',
        ...(account.payment_method_id ? { payment_method_id: account.payment_method_id } : {}),
        ...(amountForm.amount ? { amount: amountForm.amount } : {}),
      });
      toast.success(t('collected'));
      setCollectTarget(null);
    });
  };

  const payPayable = (event: React.FormEvent) => {
    event.preventDefault();
    if (!payTarget) return;
    void withSaving(async () => {
      await api.post(`/cartera/payables/${payTarget.source}/${payTarget.id}/pay`, {
        account_id: amountForm.account_id,
        ...(amountForm.amount ? { amount_cents: cents(amountForm.amount) } : {}),
      });
      toast.success(t('paymentSaved'));
      setPayTarget(null);
    });
  };

  const filteredMovements = movements.filter((row) => {
    if (accountFilter && row.account_name !== accountFilter) return false;
    if (typeFilter && row.type !== typeFilter) return false;
    if (!search) return true;
    const haystack = `${row.concept} ${row.counterparty || ''} ${row.reference || ''}`.toLowerCase();
    return haystack.includes(search.toLowerCase());
  });

  if (!moduleOn) {
    return (
      <div className="p-6 max-w-lg mx-auto text-center">
        <HandCoins size={40} className="mx-auto mb-4 text-muted-foreground" />
        <h1 className="text-xl font-bold text-foreground mb-2">{t('moduleOff')}</h1>
        <p className="text-muted-foreground mb-6">{t('moduleOffHint')}</p>
        <Link href="/settings?tab=modules">
          <Button><SettingsIcon size={16} className="me-1" /> {t('goToSettings')}</Button>
        </Link>
      </div>
    );
  }

  const openAmountModal = (accountId?: number) =>
    setAmountForm({ account_id: accountId ?? accounts[0]?.id ?? 0, amount: '' });

  const bucketRow = (label: string, value: number, max: number, bucket: AgeBucket) => (
    <div key={bucket} className="mb-3 last:mb-0">
      <div className="flex justify-between text-sm mb-1">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{fmt(value / factor)}</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full ${BUCKET_BAR[bucket]}`} style={{ width: `${max > 0 ? (value / max) * 100 : 0}%` }} />
      </div>
    </div>
  );

  return (
    <div className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('pageTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('pageSubtitle')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setTransferForm({ from: accounts[0]?.id ?? 0, to: accounts[1]?.id ?? 0, amount: '', concept: '' })}>
            <ArrowLeftRight size={15} className="me-1" /> {t('newTransfer')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEntryForm({ kind: 'expense', account_id: accounts[0]?.id ?? 0, amount: '', concept: '' })}>
            <Minus size={15} className="me-1" /> {t('newExpense')}
          </Button>
          <Button size="sm" onClick={() => setEntryForm({ kind: 'income', account_id: accounts[0]?.id ?? 0, amount: '', concept: '' })}>
            <Plus size={15} className="me-1" /> {t('newIncome')}
          </Button>
        </div>
      </div>

      <div className="flex gap-5 border-b border-border mb-5 overflow-x-auto">
        {([
          ['summary', t('tabSummary'), null],
          ['movements', t('tabMovements'), null],
          ['receivable', t('tabReceivable'), receivables.length],
          ['payable', t('tabPayable'), payables.length],
        ] as const).map(([key, label, count]) => (
          <button key={key} onClick={() => setTab(key as Tab)}
            className={`pb-2 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors ${
              tab === key ? 'border-brand text-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}>
            {label}
            {count ? <span className="ms-1.5 text-xs bg-muted px-1.5 py-0.5 rounded-full tabular-nums">{count}</span> : null}
          </button>
        ))}
      </div>

      {summary && (
        <div className="grid gap-4 lg:grid-cols-4 mb-6">
          <div className="bg-foreground text-background rounded-xl p-5">
            <p className="text-xs uppercase opacity-70">{t('availableTotal')}</p>
            <p className="text-3xl font-bold tabular-nums mt-1">{fmt(summary.available.total_cents / factor)}</p>
            <p className="text-xs opacity-70 mt-2 tabular-nums">
              <Wallet size={11} className="inline me-1" />{fmt(summary.available.cash_cents / factor)}
              <Landmark size={11} className="inline ms-3 me-1" />{fmt(summary.available.bank_cents / factor)}
            </p>
          </div>
          {summary.accounts.map((account) => {
            const Icon = ACCOUNT_ICON[account.kind];
            return (
              <div key={account.id} className="bg-card border border-border rounded-xl p-5">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <Icon size={16} className="text-muted-foreground" />
                    <span className="font-medium text-foreground">{account.name}</span>
                  </div>
                  <span className="text-[10px] uppercase bg-muted text-muted-foreground px-2 py-0.5 rounded">
                    {account.kind === 'cash' ? t('kindCash') : account.kind === 'bank' ? t('kindBank') : t('kindDigital')}
                  </span>
                </div>
                <p className="text-2xl font-bold tabular-nums mt-2">{fmt(account.balance_cents / factor)}</p>
                <p className="text-xs text-muted-foreground mt-1 tabular-nums">
                  <span className="text-green-600">↑ {fmt(account.inflow_cents / factor)}</span>
                  <span className="text-red-500 ms-3">↓ {fmt(account.outflow_cents / factor)}</span>
                </p>
              </div>
            );
          })}
        </div>
      )}

      {tab === 'summary' && summary && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              [t('title'), summary.receivables.total_cents, `${t('overdueBalance')} ${fmt(summary.receivables.overdue_cents / factor)}`],
              [t('totalPayable'), summary.payables.total_cents, `${t('overdueBalance')} ${fmt(summary.payables.overdue_cents / factor)}`],
              [t('todayMovement'), summary.today.net_cents, `↑ ${fmt(summary.today.inflow_cents / factor)} · ↓ ${fmt(summary.today.outflow_cents / factor)}`],
              [t('netPosition'), summary.net_position_cents, t('netPositionHint')],
            ].map(([label, value, hint]) => (
              <div key={String(label)} className="bg-card border border-border rounded-xl p-4">
                <p className="text-xs uppercase text-muted-foreground">{label}</p>
                <p className="text-xl font-bold tabular-nums mt-1">{fmt(Number(value) / factor)}</p>
                <p className="text-xs text-muted-foreground mt-1">{hint}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {([
              [t('agingReceivable'), t('agingReceivableHint'), summary.receivables.buckets],
              [t('agingPayable'), t('agingPayableHint'), summary.payables.buckets],
            ] as const).map(([title, hint, buckets]) => {
              const max = Math.max(...Object.values(buckets), 1);
              return (
                <div key={title} className="bg-card border border-border rounded-xl p-5">
                  <p className="text-xs uppercase text-muted-foreground">{title}</p>
                  <p className="text-xs text-muted-foreground mb-4">{hint}</p>
                  {(['current', 'week', 'month', 'overdue'] as AgeBucket[]).map((bucket) =>
                    bucketRow(ageLabel[bucket], buckets[bucket], max, bucket))}
                </div>
              );
            })}
          </div>

          <div className="bg-card border border-border rounded-xl p-5 overflow-x-auto">
            <p className="text-xs uppercase text-muted-foreground">{t('projection')}</p>
            <p className="text-xs text-muted-foreground mb-4">{t('projectionHint')}</p>
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="text-xs uppercase text-muted-foreground">
                  <th className="text-start pb-2">{t('projectionCut')}</th>
                  <th className="text-end pb-2">{t('projectionIn')}</th>
                  <th className="text-end pb-2">{t('projectionOut')}</th>
                  <th className="text-end pb-2">{t('projectionNet')}</th>
                  <th className="text-end pb-2">{t('projectionCash')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {summary.projection.map((row) => (
                  <tr key={row.days}>
                    <td className="py-2.5 font-medium">{t('projectionDays', { days: row.days })}</td>
                    <td className="py-2.5 text-end tabular-nums text-green-600">{fmt(row.incoming_cents / factor)}</td>
                    <td className="py-2.5 text-end tabular-nums text-red-500">{fmt(row.outgoing_cents / factor)}</td>
                    <td className={`py-2.5 text-end tabular-nums ${row.net_cents < 0 ? 'text-red-500' : ''}`}>{fmt(row.net_cents / factor)}</td>
                    <td className="py-2.5 text-end tabular-nums font-medium">{fmt(row.projected_cash_cents / factor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="bg-card border border-border rounded-xl p-5">
              <p className="text-xs uppercase text-muted-foreground">{t('registerToday')}</p>
              <p className="text-xs text-muted-foreground mb-4">{summary.register.business_date}</p>
              {summary.register.open ? (
                <dl className="space-y-2 text-sm">
                  {[
                    [t('openingFloat'), summary.register.opening_float_cents, ''],
                    [t('cashIn'), summary.register.cash_in_cents, 'text-green-600'],
                    [t('cashOut'), -summary.register.cash_out_cents, 'text-red-500'],
                  ].map(([label, value, cls]) => (
                    <div key={String(label)} className="flex justify-between">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className={`tabular-nums ${cls}`}>{fmt(Number(value) / factor)}</dd>
                    </div>
                  ))}
                  <div className="flex justify-between border-t border-border pt-2 font-semibold">
                    <dt>{t('expectedCash')}</dt>
                    <dd className="tabular-nums">{fmt(summary.register.expected_cash_cents / factor)}</dd>
                  </div>
                </dl>
              ) : (
                <p className="text-sm text-muted-foreground">{t('registerClosed')}</p>
              )}
            </div>

            <div className="bg-card border border-border rounded-xl p-5">
              <p className="text-xs uppercase text-muted-foreground">{t('collectionsToday')}</p>
              <p className="text-xs text-muted-foreground mb-4">{t('collectionsTodayHint')}</p>
              {summary.collections_today.length === 0 ? (
                <p className="text-sm text-muted-foreground">—</p>
              ) : (
                <ul className="space-y-2 text-sm max-h-56 overflow-y-auto">
                  {summary.collections_today.map((row, index) => (
                    <li key={`${row.bill_number}-${index}`} className="flex justify-between gap-3">
                      <span className="text-foreground truncate">{row.customer_name || row.bill_number}</span>
                      <span className="text-muted-foreground text-xs whitespace-nowrap">{row.account_name}</span>
                      <span className="tabular-nums text-green-600 whitespace-nowrap">{fmt(row.amount_cents / factor)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === 'movements' && (
        <div>
          <div className="flex flex-wrap gap-2 mb-4">
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder={t('searchMovements')}
              className="flex-1 min-w-[220px] px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand" />
            <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}
              className="px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand">
              <option value="">{t('allAccounts')}</option>
              {accounts.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
            </select>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
              className="px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand">
              <option value="">{t('allTypes')}</option>
              {Object.entries(typeLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </div>

          <div className="bg-card rounded-xl border border-border overflow-x-auto">
            <table className="w-full min-w-[880px]">
              <thead className="bg-muted">
                <tr>
                  {[t('colDate'), t('colAccount'), t('colType'), t('colConcept'), t('colParty'), t('colRef')].map((h) => (
                    <th key={h} className="text-start p-3 text-xs font-medium text-muted-foreground uppercase">{h}</th>
                  ))}
                  <th className="text-end p-3 text-xs font-medium text-muted-foreground uppercase">{t('inflow')}</th>
                  <th className="text-end p-3 text-xs font-medium text-muted-foreground uppercase">{t('outflow')}</th>
                  <th className="p-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredMovements.length === 0 && (
                  <tr><td colSpan={9} className="p-10 text-center text-muted-foreground">{t('emptyMovements')}</td></tr>
                )}
                {filteredMovements.map((row) => (
                  <tr key={row.id} className={`hover:bg-muted ${row.voided ? 'opacity-50 line-through' : ''}`}>
                    <td className="p-3 text-sm text-muted-foreground whitespace-nowrap">{formatDate(row.occurred_at)}</td>
                    <td className="p-3 text-sm">{row.account_name || '—'}</td>
                    <td className="p-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${TYPE_STYLE[row.type]}`}>
                        {typeLabel[row.type]}
                      </span>
                    </td>
                    <td className="p-3 text-sm text-foreground">{row.concept}</td>
                    <td className="p-3 text-sm text-muted-foreground">{row.counterparty || '—'}</td>
                    <td className="p-3 text-xs text-muted-foreground tabular-nums">{row.reference || '—'}</td>
                    <td className="p-3 text-end tabular-nums text-green-600 whitespace-nowrap">
                      {row.in_cents ? fmt(row.in_cents / factor) : ''}
                    </td>
                    <td className="p-3 text-end tabular-nums text-red-500 whitespace-nowrap">
                      {row.out_cents ? fmt(row.out_cents / factor) : ''}
                    </td>
                    <td className="p-3 text-end">
                      {row.id.startsWith('entry:') && !row.voided && (
                        <Button variant="ghost" size="sm" title={t('voidMovement')}
                          onClick={() => { setVoidTarget(row); setVoidReason(''); }}>
                          <Ban size={14} />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'receivable' && summary && (
        <div>
          <div className="bg-card border border-border rounded-xl p-5 mb-4 flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase text-muted-foreground">{t('totalBalance')}</p>
              <p className="text-2xl font-bold tabular-nums text-amber-600">{fmt(summary.receivables.total_cents / factor)}</p>
            </div>
            <div className="flex gap-8 text-end">
              <div>
                <p className="text-xs uppercase text-muted-foreground">{t('overdueBalance')}</p>
                <p className="font-semibold tabular-nums text-red-600">{fmt(summary.receivables.overdue_cents / factor)}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">{t('customerCount')}</p>
                <p className="font-semibold tabular-nums">{summary.receivables.customer_count}</p>
              </div>
            </div>
          </div>

          <div className="bg-card rounded-xl border border-border divide-y divide-border">
            {receivables.length === 0 && (
              <div className="p-10 text-center">
                <p className="font-medium text-foreground">{t('empty')}</p>
                <p className="text-sm text-muted-foreground">{t('emptyHint')}</p>
              </div>
            )}
            {receivables.map((row) => {
              const progress = row.total > 0 ? (row.paid_amount / row.total) * 100 : 0;
              return (
                <div key={row.bill_id} className="p-4 flex flex-wrap items-center gap-4">
                  <div className="flex-1 min-w-[220px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-foreground">{row.customer_name}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">{row.bill_number}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${AGE_STYLE[row.age_bucket]}`}>
                        {row.days_overdue > 0 ? `${row.days_overdue}d` : row.due_date ? formatDate(row.due_date) : ageLabel.current}
                      </span>
                      {row.paid_amount > 0 && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-800">
                          {t('paid')} {fmt(row.paid_amount)}
                        </span>
                      )}
                    </div>
                    {row.customer_phone && <p className="text-xs text-muted-foreground mt-0.5">{row.customer_phone}</p>}
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden mt-2 max-w-xs">
                      <div className="h-full bg-brand" style={{ width: `${progress}%` }} />
                    </div>
                  </div>
                  <div className="text-end">
                    <p className="text-lg font-bold tabular-nums">{fmt(row.balance)}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">de {fmt(row.total)}</p>
                  </div>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" title={t('setTerms')}
                      onClick={() => { setTermsTarget(row); setTermsForm({ due_date: row.due_date || '', notes: row.notes || '' }); }}>
                      <Calendar size={14} />
                    </Button>
                    <Button size="sm" className="bg-green-600 hover:bg-green-700"
                      onClick={() => { setCollectTarget(row); openAmountModal(); }}>
                      {t('collect')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'payable' && summary && (
        <div>
          <div className="flex justify-end mb-3">
            <Button variant="outline" size="sm"
              onClick={() => setPayableForm({ payee_name: '', concept: '', amount: '', due_date: '', reference: '' })}>
              <Plus size={15} className="me-1" /> {t('newPayable')}
            </Button>
          </div>

          <div className="bg-card border border-border rounded-xl p-5 mb-4 flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase text-muted-foreground">{t('totalPayable')}</p>
              <p className="text-2xl font-bold tabular-nums text-amber-600">{fmt(summary.payables.total_cents / factor)}</p>
            </div>
            <div className="flex gap-8 text-end">
              <div>
                <p className="text-xs uppercase text-muted-foreground">{t('overdueBalance')}</p>
                <p className="font-semibold tabular-nums text-red-600">{fmt(summary.payables.overdue_cents / factor)}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">{t('payees')}</p>
                <p className="font-semibold tabular-nums">{summary.payables.payee_count}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">{t('coveredByCash')}</p>
                <p className={`font-semibold ${summary.payables.covered_by_cash ? 'text-green-600' : 'text-red-600'}`}>
                  {summary.payables.covered_by_cash ? tCommon('yes') : tCommon('no')}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-card rounded-xl border border-border divide-y divide-border">
            {payables.length === 0 && (
              <div className="p-10 text-center">
                <p className="font-medium text-foreground">{t('emptyPayables')}</p>
                <p className="text-sm text-muted-foreground">{t('emptyPayablesHint')}</p>
              </div>
            )}
            {payables.map((row) => {
              const progress = row.total_cents > 0 ? (row.paid_cents / row.total_cents) * 100 : 0;
              return (
                <div key={`${row.source}-${row.id}`} className="p-4 flex flex-wrap items-center gap-4">
                  <div className="flex-1 min-w-[220px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-foreground">{row.payee}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">{row.reference || row.number}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${AGE_STYLE[row.age_bucket]}`}>
                        {row.days_overdue > 0 ? `${row.days_overdue}d` : formatDate(row.due_date)}
                      </span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                        {row.source === 'purchase' ? t('sourcePurchase') : t('sourceGeneral')}
                      </span>
                      {row.paid_cents > 0 && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-800">
                          {t('paid')} {fmt(row.paid_cents / factor)}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{row.concept}</p>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden mt-2 max-w-xs">
                      <div className="h-full bg-brand" style={{ width: `${progress}%` }} />
                    </div>
                  </div>
                  <div className="text-end">
                    <p className="text-lg font-bold tabular-nums">{fmt(row.balance_cents / factor)}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">de {fmt(row.total_cents / factor)}</p>
                  </div>
                  <Button size="sm" onClick={() => { setPayTarget(row); openAmountModal(); }}>{t('pay')}</Button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Collect / pay — one shape for both, since an abono is an abono. */}
      {(collectTarget || payTarget) && (() => {
        const isCollect = !!collectTarget;
        const balance = isCollect ? collectTarget!.balance * factor : payTarget!.balance_cents;
        const total = isCollect ? collectTarget!.total * factor : payTarget!.total_cents;
        const paid = isCollect ? collectTarget!.paid_amount * factor : payTarget!.paid_cents;
        const typed = amountForm.amount ? cents(amountForm.amount) : balance;
        const close = () => { setCollectTarget(null); setPayTarget(null); };
        return (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-card rounded-2xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
              <div className="flex justify-between items-start mb-1">
                <h2 className="text-lg font-bold">{isCollect ? t('collectTitle') : t('payTitle')}</h2>
                <button onClick={close}><X size={20} className="text-muted-foreground" /></button>
              </div>
              <p className="text-sm text-muted-foreground mb-4">{isCollect ? t('entersInto') : t('paysFrom')}</p>

              <div className="bg-muted rounded-xl p-4 mb-4">
                <p className="font-semibold text-foreground">{isCollect ? collectTarget!.customer_name : payTarget!.payee}</p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {isCollect ? collectTarget!.bill_number : (payTarget!.reference || payTarget!.number)}
                  {isCollect && collectTarget!.due_date ? ` · ${formatDate(collectTarget!.due_date)}` : ''}
                  {!isCollect ? ` · ${formatDate(payTarget!.due_date)}` : ''}
                </p>
                <div className="grid grid-cols-3 gap-2 mt-3 text-center">
                  {[[t('outstanding'), balance], [t('paid'), paid], [tCommon('total'), total]].map(([label, value], index) => (
                    <div key={String(label)} className="bg-card rounded-lg py-2">
                      <p className="text-[10px] uppercase text-muted-foreground">{label}</p>
                      <p className={`text-sm font-semibold tabular-nums ${index === 0 ? 'text-amber-600' : ''}`}>
                        {fmt(Number(value) / factor)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <form onSubmit={isCollect ? collect : payPayable} className="space-y-3">
                <div>
                  <span className="text-xs font-medium text-muted-foreground uppercase">
                    {isCollect ? t('entersInto') : t('paysFrom')}
                  </span>
                  <div className="grid grid-cols-2 gap-2 mt-1">
                    {accounts.map((account) => (
                      <button key={account.id} type="button"
                        onClick={() => setAmountForm({ ...amountForm, account_id: account.id })}
                        className={`text-start px-3 py-2 rounded-lg border text-sm transition-colors ${
                          amountForm.account_id === account.id
                            ? 'border-brand bg-brand/5 text-foreground'
                            : 'border-border text-muted-foreground hover:border-rule'
                        }`}>
                        <span className="block font-medium">{account.name}</span>
                        <span className="block text-xs tabular-nums opacity-70">{fmt(account.balance_cents / factor)}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <label className="block">
                  <span className="text-xs font-medium text-muted-foreground uppercase">{t('amount')}</span>
                  <input type="number" min="0" step="any" inputMode="decimal" value={amountForm.amount}
                    onChange={(e) => setAmountForm({ ...amountForm, amount: e.target.value })}
                    placeholder={String(balance / factor)}
                    className="mt-1 w-full px-3 py-2 text-end text-lg font-semibold border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand tabular-nums" />
                </label>

                <div className="flex gap-2">
                  <button type="button" className="text-xs px-2.5 py-1 rounded bg-muted text-muted-foreground hover:text-foreground"
                    onClick={() => setAmountForm({ ...amountForm, amount: String(Math.round(balance / 2) / factor) })}>
                    {t('half')}
                  </button>
                  <button type="button" className="text-xs px-2.5 py-1 rounded bg-muted text-muted-foreground hover:text-foreground"
                    onClick={() => setAmountForm({ ...amountForm, amount: '' })}>
                    {t('fullBalance')}
                  </button>
                </div>

                {typed > 0 && typed < balance && (
                  <p className="text-xs bg-amber-50 text-amber-800 rounded-lg px-3 py-2 tabular-nums">
                    {t('remaining')} {fmt((balance - typed) / factor)}
                  </p>
                )}

                <div className="flex gap-2 pt-1">
                  <Button type="button" variant="outline" className="flex-1" onClick={close}>{tCommon('cancel')}</Button>
                  <Button type="submit" className={`flex-1 ${isCollect ? 'bg-green-600 hover:bg-green-700' : ''}`} disabled={saving || !amountForm.account_id}>
                    {isCollect ? t('collect') : t('pay')} {fmt(Math.min(typed, balance) / factor)}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        );
      })()}

      {termsTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-2xl p-6 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{t('setTerms')}</h2>
              <button onClick={() => setTermsTarget(null)}><X size={20} className="text-muted-foreground" /></button>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              void withSaving(async () => {
                await api.put(`/receivables/${termsTarget.bill_id}/terms`, termsForm);
                toast.success(t('termsSaved'));
                setTermsTarget(null);
              });
            }} className="space-y-3">
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground uppercase">{t('dueDate')}</span>
                <input type="date" value={termsForm.due_date} required
                  onChange={(e) => setTermsForm({ ...termsForm, due_date: e.target.value })}
                  className="mt-1 w-full px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand" />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground uppercase">{`${t('notes')} (${tCommon('optional')})`}</span>
                <textarea value={termsForm.notes} rows={2}
                  onChange={(e) => setTermsForm({ ...termsForm, notes: e.target.value })}
                  className="mt-1 w-full px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand" />
              </label>
              <Button type="submit" className="w-full" disabled={saving}>{tCommon('save')}</Button>
            </form>
          </div>
        </div>
      )}

      {entryForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-2xl p-6 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{entryForm.kind === 'income' ? t('newIncome') : t('newExpense')}</h2>
              <button onClick={() => setEntryForm(null)}><X size={20} className="text-muted-foreground" /></button>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              void withSaving(async () => {
                await api.post('/cartera/movements', {
                  account_id: entryForm.account_id, kind: entryForm.kind,
                  amount_cents: cents(entryForm.amount), concept: entryForm.concept,
                });
                toast.success(t('movementSaved'));
                setEntryForm(null);
              });
            }} className="space-y-3">
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground uppercase">{t('colAccount')}</span>
                <select value={entryForm.account_id} required
                  onChange={(e) => setEntryForm({ ...entryForm, account_id: Number(e.target.value) })}
                  className="mt-1 w-full px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand">
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground uppercase">{t('concept')}</span>
                <input type="text" value={entryForm.concept} required
                  onChange={(e) => setEntryForm({ ...entryForm, concept: e.target.value })}
                  className="mt-1 w-full px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand" />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground uppercase">{t('amount')}</span>
                <input type="number" min="0" step="any" inputMode="decimal" value={entryForm.amount} required
                  onChange={(e) => setEntryForm({ ...entryForm, amount: e.target.value })}
                  className="mt-1 w-full px-3 py-2 text-end border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand tabular-nums" />
              </label>
              <Button type="submit" className="w-full" disabled={saving}>{tCommon('save')}</Button>
            </form>
          </div>
        </div>
      )}

      {transferForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-2xl p-6 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{t('newTransfer')}</h2>
              <button onClick={() => setTransferForm(null)}><X size={20} className="text-muted-foreground" /></button>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              void withSaving(async () => {
                await api.post('/cartera/transfers', {
                  from_account_id: transferForm.from, to_account_id: transferForm.to,
                  amount_cents: cents(transferForm.amount), concept: transferForm.concept,
                });
                toast.success(t('transferSaved'));
                setTransferForm(null);
              });
            }} className="space-y-3">
              {([['from', t('fromAccount')], ['to', t('toAccount')]] as const).map(([field, label]) => (
                <label key={field} className="block">
                  <span className="text-xs font-medium text-muted-foreground uppercase">{label}</span>
                  <select value={transferForm[field]} required
                    onChange={(e) => setTransferForm({ ...transferForm, [field]: Number(e.target.value) })}
                    className="mt-1 w-full px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand">
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </label>
              ))}
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground uppercase">{t('amount')}</span>
                <input type="number" min="0" step="any" inputMode="decimal" value={transferForm.amount} required
                  onChange={(e) => setTransferForm({ ...transferForm, amount: e.target.value })}
                  className="mt-1 w-full px-3 py-2 text-end border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand tabular-nums" />
              </label>
              <Button type="submit" className="w-full" disabled={saving}>{tCommon('save')}</Button>
            </form>
          </div>
        </div>
      )}

      {payableForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-2xl p-6 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{t('newPayable')}</h2>
              <button onClick={() => setPayableForm(null)}><X size={20} className="text-muted-foreground" /></button>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              void withSaving(async () => {
                await api.post('/cartera/payables', {
                  payee_name: payableForm.payee_name, concept: payableForm.concept,
                  total_cents: cents(payableForm.amount), due_date: payableForm.due_date,
                  reference: payableForm.reference || null,
                });
                toast.success(t('payableSaved'));
                setPayableForm(null);
              });
            }} className="space-y-3">
              {([
                ['payee_name', t('payee'), 'text', true],
                ['concept', t('concept'), 'text', true],
                ['reference', t('reference'), 'text', false],
              ] as const).map(([field, label, type, required]) => (
                <label key={field} className="block">
                  <span className="text-xs font-medium text-muted-foreground uppercase">{label}</span>
                  <input type={type} value={payableForm[field]} required={required}
                    onChange={(e) => setPayableForm({ ...payableForm, [field]: e.target.value })}
                    className="mt-1 w-full px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand" />
                </label>
              ))}
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground uppercase">{t('payableTotal')}</span>
                <input type="number" min="0" step="any" inputMode="decimal" value={payableForm.amount} required
                  onChange={(e) => setPayableForm({ ...payableForm, amount: e.target.value })}
                  className="mt-1 w-full px-3 py-2 text-end border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand tabular-nums" />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground uppercase">{t('dueDate')}</span>
                <input type="date" value={payableForm.due_date} required
                  onChange={(e) => setPayableForm({ ...payableForm, due_date: e.target.value })}
                  className="mt-1 w-full px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand" />
              </label>
              <Button type="submit" className="w-full" disabled={saving}>{tCommon('save')}</Button>
            </form>
          </div>
        </div>
      )}

      {voidTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-2xl p-6 w-full max-w-sm">
            <div className="flex justify-between items-center mb-2">
              <h2 className="text-lg font-bold">{t('voidMovement')}</h2>
              <button onClick={() => setVoidTarget(null)}><X size={20} className="text-muted-foreground" /></button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">{voidTarget.concept}</p>
            <textarea value={voidReason} onChange={(e) => setVoidReason(e.target.value)}
              placeholder={t('voidReason')} rows={3}
              className="w-full px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand mb-4" />
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setVoidTarget(null)}>{tCommon('cancel')}</Button>
              <Button className="flex-1" disabled={saving} onClick={() => void withSaving(async () => {
                await api.post(`/cartera/movements/${voidTarget.id.replace('entry:', '')}/void`, { reason: voidReason });
                toast.success(t('voided'));
                setVoidTarget(null);
              })}>{t('voidMovement')}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
