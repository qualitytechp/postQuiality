'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';
import {
  Plus, X, Trash2, Ban, Truck, Settings as SettingsIcon, Search,
  ChevronDown, ChevronUp, Receipt, Wallet, Clock, MoreVertical, Pencil,
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

interface Supplier { id: string; name: string; document: string | null; phone: string | null; is_active: number }
interface ProductOption { id: string; name: string; sale_unit: string; track_inventory: number }

interface PurchaseItem {
  id: number; product_id: string | null; description: string;
  quantity: number; unit: string; unit_cost_cents: number; line_total_cents: number;
  inventory_added_quantity: number;
}

interface PurchasePayment { id: number; amount_cents: number; method: string; paid_at: string }

interface PurchaseRow {
  id: number; purchase_number: string; supplier_name: string; invoice_ref: string | null;
  total_cents: number; paid_cents: number; balance_cents: number;
  payment_terms: 'cash' | 'credit'; due_date: string | null;
  status: 'received' | 'void'; settlement: 'pending' | 'partial' | 'paid' | 'void';
  received_at: string; item_count: number; unit_count: number;
  payment_methods: string | null;
  items: PurchaseItem[]; payments: PurchasePayment[];
}

interface MonthStats {
  purchase_count: number; unit_count: number; spent_cents: number;
  outstanding_count: number; outstanding_cents: number;
}

interface DraftLine { key: number; product_id: string; description: string; quantity: string; unit_cost: string }

const emptyLine = (key: number): DraftLine => ({ key, product_id: '', description: '', quantity: '', unit_cost: '' });

const SETTLEMENT_STYLE: Record<PurchaseRow['settlement'], string> = {
  pending: 'bg-amber-100 text-amber-800',
  partial: 'bg-blue-100 text-blue-800',
  paid: 'bg-green-100 text-green-800',
  void: 'bg-red-100 text-red-800',
};

const SETTLEMENT_ICON_STYLE: Record<PurchaseRow['settlement'], string> = {
  pending: 'bg-amber-50 text-amber-600',
  partial: 'bg-blue-50 text-blue-600',
  paid: 'bg-green-50 text-green-600',
  void: 'bg-red-50 text-red-600',
};

export default function PurchasesPage() {
  const t = useTranslations('purchases');
  const tCommon = useTranslations('common');
  const { currentTenant } = useAuthStore();
  const modules = usePosSettingsStore((s) => s.modules);
  const fmt = useFormatCurrency();
  const { formatDateTime } = useFormatDate();
  const factor = getCurrencyMinorUnitFactor(currentTenant?.currency || 'INR');

  const [purchases, setPurchases] = useState<PurchaseRow[]>([]);
  const [stats, setStats] = useState<MonthStats | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [saving, setSaving] = useState(false);

  const [filter, setFilter] = useState<'all' | 'unpaid' | 'paid'>('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [menuFor, setMenuFor] = useState<number | null>(null);

  const [showPurchaseForm, setShowPurchaseForm] = useState(false);
  const [showSupplierForm, setShowSupplierForm] = useState(false);
  const [voidTarget, setVoidTarget] = useState<PurchaseRow | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [payTarget, setPayTarget] = useState<PurchaseRow | null>(null);
  const [payForm, setPayForm] = useState({ amount: '', method: 'transfer' });
  // Editar reusa el mismo formulario que registrar: es el mismo documento, y
  // dos formularios distintos para lo mismo se desincronizan con el tiempo.
  const [editing, setEditing] = useState<PurchaseRow | null>(null);
  const [editReason, setEditReason] = useState('');

  const [supplierForm, setSupplierForm] = useState({ name: '', document: '', phone: '', address: '' });
  const [nextLineKey, setNextLineKey] = useState(1);
  const [form, setForm] = useState({
    supplier_id: '', invoice_ref: '', payment_terms: 'credit' as 'cash' | 'credit', due_date: '', notes: '',
  });
  const [lines, setLines] = useState<DraftLine[]>([emptyLine(0)]);

  const moduleOn = modules?.purchases;
  const loading = !!moduleOn && !loaded;

  const load = useCallback(async () => {
    const [p, s, pr] = await Promise.all([
      api.get('/purchases', { params: { limit: 100 } }),
      api.get('/suppliers'),
      api.get('/products', { params: { limit: 500 } }),
    ]);
    return {
      purchases: (p.data.purchases || []) as PurchaseRow[],
      stats: (p.data.stats || null) as MonthStats | null,
      suppliers: (s.data.suppliers || []) as Supplier[],
      products: (pr.data.data || pr.data.products || []) as ProductOption[],
    };
  }, []);

  useEffect(() => {
    if (!moduleOn) return;
    let active = true;
    load()
      .then((data) => {
        if (!active) return;
        setPurchases(data.purchases);
        setStats(data.stats);
        setSuppliers(data.suppliers);
        setProducts(data.products);
      })
      .catch(() => { if (active) toast.error(t('loadFailed')); })
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [moduleOn, refreshKey, load, t]);

  const refresh = () => setRefreshKey((key) => key + 1);
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const lineTotalCents = useCallback((line: DraftLine) => {
    const quantity = Number(line.quantity);
    const unitCost = Number(line.unit_cost);
    if (!Number.isFinite(quantity) || !Number.isFinite(unitCost)) return 0;
    return Math.round(quantity * Math.round(unitCost * factor));
  }, [factor]);

  const draftTotalCents = useMemo(
    () => lines.reduce((sum, line) => sum + lineTotalCents(line), 0),
    [lines, lineTotalCents],
  );

  const counts = useMemo(() => ({
    all: purchases.length,
    unpaid: purchases.filter((p) => p.settlement === 'pending' || p.settlement === 'partial').length,
    paid: purchases.filter((p) => p.settlement === 'paid').length,
  }), [purchases]);

  const visible = useMemo(() => purchases.filter((row) => {
    if (filter === 'unpaid' && !(row.settlement === 'pending' || row.settlement === 'partial')) return false;
    if (filter === 'paid' && row.settlement !== 'paid') return false;
    if (!search) return true;
    const needle = search.toLowerCase();
    return [row.supplier_name, row.invoice_ref, row.purchase_number, ...row.items.map((i) => i.description)]
      .some((value) => (value || '').toLowerCase().includes(needle));
  }), [purchases, filter, search]);

  const openEdit = (row: PurchaseRow) => {
    setEditing(row);
    setEditReason('');
    setForm({
      supplier_id: '', invoice_ref: row.invoice_ref || '',
      payment_terms: row.payment_terms, due_date: row.due_date || '', notes: '',
    });
    setLines(row.items.map((item, index) => ({
      key: index,
      product_id: item.product_id || '',
      description: item.description,
      quantity: String(item.quantity),
      unit_cost: String(item.unit_cost_cents / factor),
    })));
    setNextLineKey(row.items.length);
    setShowPurchaseForm(true);
  };

  const resetPurchaseForm = () => {
    setForm({ supplier_id: '', invoice_ref: '', payment_terms: 'credit', due_date: '', notes: '' });
    setLines([emptyLine(0)]);
    setNextLineKey(1);
  };

  const addLine = () => {
    setLines((current) => [...current, emptyLine(nextLineKey)]);
    setNextLineKey((key) => key + 1);
  };

  const updateLine = (key: number, patch: Partial<DraftLine>) => {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  };

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

  const saveSupplier = (event: React.FormEvent) => {
    event.preventDefault();
    if (!supplierForm.name.trim()) { toast.error(t('supplierNameRequired')); return; }
    void withSaving(async () => {
      await api.post('/suppliers', supplierForm);
      toast.success(t('supplierSaved'));
      setSupplierForm({ name: '', document: '', phone: '', address: '' });
      setShowSupplierForm(false);
    });
  };

  const savePurchase = (event: React.FormEvent) => {
    event.preventDefault();
    const usable = lines.filter((line) => Number(line.quantity) > 0);
    if (usable.length === 0) { toast.error(t('needsOneLine')); return; }
    if (form.payment_terms === 'credit' && !form.due_date) { toast.error(t('dueDateRequired')); return; }
    void withSaving(async () => {
      await api.post('/purchases', {
        supplier_id: form.supplier_id,
        invoice_ref: form.invoice_ref || null,
        notes: form.notes || null,
        payment_terms: form.payment_terms,
        due_date: form.payment_terms === 'credit' ? form.due_date : null,
        items: usable.map((line) => ({
          product_id: line.product_id || null,
          description: line.description || productById.get(line.product_id)?.name || '',
          quantity: Number(line.quantity),
          unit_cost_cents: Math.round(Number(line.unit_cost) * factor),
        })),
      });
      toast.success(t('saved'));
      resetPurchaseForm();
      setShowPurchaseForm(false);
    });
  };

  const saveEdit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const usable = lines.filter((line) => Number(line.quantity) > 0);
    if (usable.length === 0) { toast.error(t('needsOneLine')); return; }
    if (form.payment_terms === 'credit' && !form.due_date) { toast.error(t('dueDateRequired')); return; }
    void withSaving(async () => {
      await api.put(`/purchases/${editing.id}`, {
        invoice_ref: form.invoice_ref || null,
        payment_terms: form.payment_terms,
        due_date: form.payment_terms === 'credit' ? form.due_date : null,
        ...(form.supplier_id ? { supplier_id: form.supplier_id } : {}),
        items: usable.map((line) => ({
          product_id: line.product_id || null,
          description: line.description || productById.get(line.product_id)?.name || '',
          quantity: Number(line.quantity),
          unit_cost_cents: Math.round(Number(line.unit_cost) * factor),
        })),
        reason: editReason || null,
      });
      toast.success(t('editSaved'));
      resetPurchaseForm();
      setEditing(null);
      setShowPurchaseForm(false);
    });
  };

  const registerPayment = (event: React.FormEvent) => {
    event.preventDefault();
    if (!payTarget) return;
    void withSaving(async () => {
      await api.post(`/purchases/${payTarget.id}/payments`, {
        method: payForm.method,
        ...(payForm.amount ? { amount_cents: Math.round(Number(payForm.amount) * factor) } : {}),
      });
      toast.success(t('abonoSaved'));
      setPayTarget(null);
    });
  };

  if (!moduleOn) {
    return (
      <div className="p-6 max-w-lg mx-auto text-center">
        <Truck size={40} className="mx-auto mb-4 text-muted-foreground" />
        <h1 className="text-xl font-bold text-foreground mb-2">{t('moduleOff')}</h1>
        <p className="text-muted-foreground mb-6">{t('moduleOffHint')}</p>
        <Link href="/settings?tab=modules">
          <Button><SettingsIcon size={16} className="me-1" /> {t('goToSettings')}</Button>
        </Link>
      </div>
    );
  }

  const statusLabel = (row: PurchaseRow) => (
    row.settlement === 'void' ? t('statusVoid')
      : row.settlement === 'paid' ? t('statusPaid')
        : row.settlement === 'partial' ? t('statusPartial') : t('statusPending')
  );

  const methodLabel = (method: string) => (
    method === 'cash' ? t('methodCash') : method === 'transfer' ? t('methodTransfer') : method
  );

  return (
    <div className="p-6" onClick={() => setMenuFor(null)}>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitleLong')}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setShowSupplierForm(true)}>
            <Plus size={16} className="me-1" /> {t('newSupplier')}
          </Button>
          <Button onClick={() => { setEditing(null); resetPurchaseForm(); setShowPurchaseForm(true); }} disabled={suppliers.length === 0}>
            <Plus size={16} className="me-1" /> {t('newPurchase')}
          </Button>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-4 mb-5 flex items-start gap-3">
        <span className="shrink-0 w-9 h-9 rounded-lg bg-foreground text-background flex items-center justify-center">
          <Truck size={17} />
        </span>
        <p className="text-sm text-muted-foreground leading-relaxed">{t('explainer')}</p>
      </div>

      {stats && (
        <div className="grid gap-4 sm:grid-cols-3 mb-5">
          {([
            [Truck, t('statPurchases'), String(stats.purchase_count), t('statPurchasesHint', { units: stats.unit_count })],
            [Receipt, t('statSpent'), fmt(stats.spent_cents / factor), t('statSpentHint')],
            [Clock, t('statOutstanding'), fmt(stats.outstanding_cents / factor), t('statOutstandingHint', { count: stats.outstanding_count })],
          ] as const).map(([Icon, label, value, hint]) => (
            <div key={label} className="bg-card border border-border rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="w-7 h-7 rounded-lg bg-muted flex items-center justify-center text-muted-foreground">
                  <Icon size={15} />
                </span>
                <span className="text-xs uppercase text-muted-foreground">{label}</span>
              </div>
              <p className="text-2xl font-bold tabular-nums">{value}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex gap-1 bg-muted rounded-lg p-1">
          {([
            ['all', t('filterAll'), counts.all],
            ['unpaid', t('filterUnpaid'), counts.unpaid],
            ['paid', t('filterPaid'), counts.paid],
          ] as const).map(([key, label, count]) => (
            <button key={key} onClick={() => setFilter(key)}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                filter === key ? 'bg-card text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'
              }`}>
              {label} <span className="text-xs tabular-nums opacity-70">{count}</span>
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('search')}
            className="w-full ps-9 pe-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand" />
        </div>
      </div>

      <div className="space-y-3">
        {visible.length === 0 && !loading && (
          <div className="bg-card border border-border rounded-xl p-10 text-center">
            <p className="font-medium text-foreground">{suppliers.length === 0 ? t('emptySuppliers') : t('empty')}</p>
            <p className="text-sm text-muted-foreground">{suppliers.length === 0 ? t('emptySuppliersHint') : t('emptyHint')}</p>
          </div>
        )}

        {visible.map((row) => {
          const open = expanded === row.id;
          const progress = row.total_cents > 0 ? (row.paid_cents / row.total_cents) * 100 : 0;
          const methods = (row.payment_methods || '').split(',').filter(Boolean).map(methodLabel).join(' · ');
          return (
            <div key={row.id} className="bg-card border border-border rounded-xl overflow-hidden">
              <div className="p-4 flex flex-wrap items-center gap-4">
                <span className={`shrink-0 w-10 h-10 rounded-lg flex items-center justify-center ${SETTLEMENT_ICON_STYLE[row.settlement]}`}>
                  <Receipt size={18} />
                </span>
                <div className="flex-1 min-w-[200px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-foreground">
                      {t('invoice')} {row.invoice_ref || row.purchase_number}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${SETTLEMENT_STYLE[row.settlement]}`}>
                      {statusLabel(row)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {formatDateTime(row.received_at)} · {t('productsAndUnits', { products: row.item_count, units: row.unit_count })}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                    <Truck size={12} /> {row.supplier_name}
                  </p>
                </div>
                <div className="text-end">
                  <p className="text-lg font-bold tabular-nums">{fmt(row.total_cents / factor)}</p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {/* A void purchase owes nothing: saying "to pay" about one
                        would put it back on the merchant's mental list. The
                        badge already says it is void, so nothing goes here. */}
                    {row.settlement === 'void' ? ''
                      : row.settlement === 'paid' ? t('paidWith', { method: methods || methodLabel('cash') })
                        : row.settlement === 'partial'
                          ? t('balanceOf', { balance: fmt(row.balance_cents / factor), paid: fmt(row.paid_cents / factor) })
                          : t('toTransfer')}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="sm" onClick={() => setExpanded(open ? null : row.id)}>
                    {open ? <ChevronUp size={14} className="me-1" /> : <ChevronDown size={14} className="me-1" />}
                    {open ? t('hideDetail') : t('showDetail')}
                  </Button>
                  <div className="relative">
                    <Button variant="ghost" size="sm"
                      onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === row.id ? null : row.id); }}>
                      <MoreVertical size={15} />
                    </Button>
                    {menuFor === row.id && row.settlement !== 'void' && (
                      <div className="absolute end-0 top-full mt-1 z-20 bg-card border border-border rounded-lg shadow-lg py-1 min-w-[150px]"
                        onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => { openEdit(row); setMenuFor(null); }}
                          className="w-full text-start px-3 py-2 text-sm text-foreground hover:bg-muted flex items-center gap-2">
                          <Pencil size={14} /> {t('edit')}
                        </button>
                        <button
                          onClick={() => { setVoidTarget(row); setVoidReason(''); setMenuFor(null); }}
                          className="w-full text-start px-3 py-2 text-sm text-red-600 hover:bg-muted flex items-center gap-2">
                          <Ban size={14} /> {t('voidPurchase')}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {open && (
                <div className="border-t border-border bg-muted/30 p-4">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[520px] text-sm">
                      <thead>
                        <tr className="text-xs uppercase text-muted-foreground">
                          <th className="text-start pb-2">{t('colProduct')}</th>
                          <th className="text-end pb-2">{t('colQuantity')}</th>
                          <th className="text-end pb-2">{t('colUnitCost')}</th>
                          <th className="text-end pb-2">{t('colSubtotal')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {row.items.map((item) => (
                          <tr key={item.id}>
                            <td className="py-2.5 text-foreground">{item.description}</td>
                            <td className="py-2.5 text-end tabular-nums text-brand">
                              {item.quantity}{item.unit !== 'each' ? ` ${item.unit}` : ''}
                            </td>
                            <td className="py-2.5 text-end tabular-nums">{fmt(item.unit_cost_cents / factor)}</td>
                            <td className="py-2.5 text-end tabular-nums">{fmt(item.line_total_cents / factor)}</td>
                          </tr>
                        ))}
                        <tr>
                          <td colSpan={3} className="pt-3 text-end text-xs uppercase text-muted-foreground">{t('total')}</td>
                          <td className="pt-3 text-end font-bold tabular-nums">{fmt(row.total_cents / factor)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  <div className="mt-4 bg-card border border-border rounded-lg p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                      <span className="text-xs uppercase text-muted-foreground">{t('paymentsToSupplier')}</span>
                      <span className="text-xs tabular-nums">
                        <span className="text-muted-foreground">{t('paid')} </span>
                        <span className="font-medium">{fmt(row.paid_cents / factor)}</span>
                        <span className="text-muted-foreground ms-3">{t('outstanding')} </span>
                        <span className={`font-medium ${row.balance_cents > 0 ? 'text-amber-600' : 'text-green-600'}`}>
                          {fmt(row.balance_cents / factor)}
                        </span>
                      </span>
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-brand" style={{ width: `${Math.min(100, progress)}%` }} />
                    </div>
                    {row.payments.length > 0 && (
                      <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                        {row.payments.map((payment) => (
                          <li key={payment.id} className="flex justify-between tabular-nums">
                            <span>{formatDateTime(payment.paid_at)} · {methodLabel(payment.method)}</span>
                            <span>{fmt(payment.amount_cents / factor)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {row.balance_cents > 0 && row.settlement !== 'void' && (
                    <Button className="mt-3" onClick={() => { setPayTarget(row); setPayForm({ amount: '', method: 'transfer' }); }}>
                      <Wallet size={15} className="me-1" /> {t('registerPayment')}
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {payTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-2xl p-6 w-full max-w-sm">
            <div className="flex justify-between items-center mb-1">
              <h2 className="text-lg font-bold">{t('abonoTitle')}</h2>
              <button onClick={() => setPayTarget(null)}><X size={20} className="text-muted-foreground" /></button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              {payTarget.supplier_name} · {payTarget.invoice_ref || payTarget.purchase_number}
            </p>
            <div className="grid grid-cols-3 gap-2 mb-4 text-center">
              {([
                [t('outstanding'), payTarget.balance_cents, 'text-amber-600'],
                [t('paid'), payTarget.paid_cents, ''],
                [t('total'), payTarget.total_cents, ''],
              ] as const).map(([label, value, cls]) => (
                <div key={label} className="bg-muted rounded-lg py-2">
                  <p className="text-[10px] uppercase text-muted-foreground">{label}</p>
                  <p className={`text-sm font-semibold tabular-nums ${cls}`}>{fmt(value / factor)}</p>
                </div>
              ))}
            </div>
            <form onSubmit={registerPayment} className="space-y-3">
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground uppercase">{t('abonoMethod')}</span>
                <select value={payForm.method} onChange={(e) => setPayForm({ ...payForm, method: e.target.value })}
                  className="mt-1 w-full px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand">
                  <option value="transfer">{t('methodTransfer')}</option>
                  <option value="cash">{t('methodCash')}</option>
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground uppercase">{t('abonoAmount')}</span>
                <input type="number" min="0" step="any" inputMode="decimal" value={payForm.amount}
                  onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })}
                  placeholder={String(payTarget.balance_cents / factor)}
                  className="mt-1 w-full px-3 py-2 text-end text-lg font-semibold border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand tabular-nums" />
              </label>
              <button type="button" className="text-xs px-2.5 py-1 rounded bg-muted text-muted-foreground hover:text-foreground"
                onClick={() => setPayForm({ ...payForm, amount: '' })}>
                {t('fullBalance')}
              </button>
              <div className="flex gap-2 pt-1">
                <Button type="button" variant="outline" className="flex-1" onClick={() => setPayTarget(null)}>{tCommon('cancel')}</Button>
                <Button type="submit" className="flex-1" disabled={saving}>{t('registerPayment')}</Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showSupplierForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-2xl p-6 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{t('newSupplier')}</h2>
              <button onClick={() => setShowSupplierForm(false)}><X size={20} className="text-muted-foreground" /></button>
            </div>
            <form onSubmit={saveSupplier} className="space-y-3">
              {([
                ['name', t('supplierName'), true],
                ['document', `${t('document')} (${tCommon('optional')})`, false],
                ['phone', `${t('phone')} (${tCommon('optional')})`, false],
                ['address', `${t('address')} (${tCommon('optional')})`, false],
              ] as const).map(([field, label, required]) => (
                <input key={field} type="text" placeholder={label} required={required}
                  value={supplierForm[field]}
                  onChange={(e) => setSupplierForm({ ...supplierForm, [field]: e.target.value })}
                  className="w-full px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand" />
              ))}
              <Button type="submit" className="w-full" disabled={saving}>{tCommon('save')}</Button>
            </form>
          </div>
        </div>
      )}

      {showPurchaseForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center p-6 pb-4 border-b border-border sticky top-0 bg-card z-10">
              <h2 className="text-lg font-bold">{editing ? t('editTitle') : t('newPurchase')}</h2>
              <button onClick={() => { setShowPurchaseForm(false); setEditing(null); }}>
                <X size={20} className="text-muted-foreground" />
              </button>
            </div>
            <form onSubmit={editing ? saveEdit : savePurchase} className="p-6 space-y-4">
              {editing && (
                <p className="text-sm text-muted-foreground bg-muted rounded-lg px-3 py-2">{t('editHint')}</p>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="text-xs font-medium text-muted-foreground uppercase">{t('supplier')}</span>
                  {/* Con abonos hechos el proveedor ya no se cambia: esa plata
                      se le entregó a alguien concreto. */}
                  <select value={form.supplier_id} required={!editing}
                    disabled={!!editing && editing.paid_cents > 0}
                    onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}
                    className="mt-1 w-full px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand disabled:opacity-60">
                    <option value="">{editing ? editing.supplier_name : '—'}</option>
                    {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-muted-foreground uppercase">{t('invoiceRef')}</span>
                  <input type="text" value={form.invoice_ref}
                    onChange={(e) => setForm({ ...form, invoice_ref: e.target.value })}
                    className="mt-1 w-full px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand" />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-muted-foreground uppercase">{t('paymentTerms')}</span>
                  <select value={form.payment_terms}
                    onChange={(e) => setForm({ ...form, payment_terms: e.target.value as 'cash' | 'credit' })}
                    className="mt-1 w-full px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand">
                    <option value="credit">{t('termsCredit')}</option>
                    <option value="cash">{t('termsCash')}</option>
                  </select>
                </label>
                {form.payment_terms === 'credit' && (
                  <label className="block">
                    <span className="text-xs font-medium text-muted-foreground uppercase">{t('dueDate')}</span>
                    <input type="date" value={form.due_date} required
                      onChange={(e) => setForm({ ...form, due_date: e.target.value })}
                      className="mt-1 w-full px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand" />
                  </label>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-muted-foreground uppercase">{t('lines')}</span>
                  <Button type="button" variant="outline" size="sm" onClick={addLine}>
                    <Plus size={14} className="me-1" /> {t('addLine')}
                  </Button>
                </div>
                <div className="space-y-2">
                  {lines.map((line) => {
                    const product = productById.get(line.product_id);
                    return (
                      <div key={line.key} className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_90px_110px_minmax(0,1fr)_36px] items-end border border-border rounded-lg p-3">
                        <label className="block min-w-0">
                          <span className="text-xs text-muted-foreground">{t('product')}</span>
                          <select value={line.product_id}
                            onChange={(e) => updateLine(line.key, { product_id: e.target.value })}
                            className="mt-1 w-full px-2 py-1.5 border border-border rounded bg-card text-sm outline-none focus:ring-2 focus:ring-brand">
                            <option value="">{t('noProduct')}</option>
                            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                          {!line.product_id && (
                            <input type="text" placeholder={t('lineDescription')} value={line.description}
                              onChange={(e) => updateLine(line.key, { description: e.target.value })}
                              className="mt-2 w-full px-2 py-1.5 border border-border rounded bg-card text-sm outline-none focus:ring-2 focus:ring-brand" />
                          )}
                        </label>
                        <label className="block">
                          <span className="text-xs text-muted-foreground">
                            {t('quantity')}{product ? ` (${product.sale_unit})` : ''}
                          </span>
                          <input type="number" min="0" step="any" value={line.quantity} inputMode="decimal"
                            onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                            className="mt-1 w-full px-2 py-1.5 border border-border rounded bg-card text-sm text-end tabular-nums outline-none focus:ring-2 focus:ring-brand" />
                        </label>
                        <label className="block">
                          <span className="text-xs text-muted-foreground">{t('unitCost')}</span>
                          <input type="number" min="0" step="any" value={line.unit_cost} inputMode="decimal"
                            onChange={(e) => updateLine(line.key, { unit_cost: e.target.value })}
                            className="mt-1 w-full px-2 py-1.5 border border-border rounded bg-card text-sm text-end tabular-nums outline-none focus:ring-2 focus:ring-brand" />
                        </label>
                        <div className="text-end">
                          <span className="text-xs text-muted-foreground block">{t('lineTotal')}</span>
                          <span className="text-sm font-medium tabular-nums">{fmt(lineTotalCents(line) / factor)}</span>
                          {product && !product.track_inventory && (
                            <span className="text-xs text-muted-foreground block">{t('stockNotTracked')}</span>
                          )}
                        </div>
                        <button type="button" aria-label={t('removeLine')}
                          onClick={() => setLines((current) => (current.length > 1 ? current.filter((l) => l.key !== line.key) : current))}
                          className="p-2 text-muted-foreground hover:text-red-600 disabled:opacity-30"
                          disabled={lines.length === 1}>
                          <Trash2 size={16} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {editing && (
                <label className="block">
                  <span className="text-xs font-medium text-muted-foreground uppercase">{t('editReason')}</span>
                  <input type="text" value={editReason} onChange={(e) => setEditReason(e.target.value)}
                    className="mt-1 w-full px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand" />
                </label>
              )}

              <div className="flex items-center justify-between border-t border-border pt-4">
                <span className="text-sm font-medium text-muted-foreground uppercase">{t('total')}</span>
                <span className="text-xl font-bold tabular-nums">{fmt(draftTotalCents / factor)}</span>
              </div>

              <Button type="submit" className="w-full" disabled={saving}>{tCommon('save')}</Button>
            </form>
          </div>
        </div>
      )}

      {voidTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-2xl p-6 w-full max-w-sm">
            <div className="flex justify-between items-center mb-2">
              <h2 className="text-lg font-bold">{t('voidPurchase')}</h2>
              <button onClick={() => setVoidTarget(null)}><X size={20} className="text-muted-foreground" /></button>
            </div>
            <p className="text-sm text-muted-foreground mb-1 tabular-nums">
              {t('invoice')} {voidTarget.invoice_ref || voidTarget.purchase_number}
            </p>
            <p className="text-sm text-muted-foreground mb-4">{t('voidHint')}</p>
            <textarea value={voidReason} onChange={(e) => setVoidReason(e.target.value)}
              placeholder={t('voidReason')} rows={3}
              className="w-full px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand mb-4" />
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setVoidTarget(null)}>{tCommon('cancel')}</Button>
              <Button className="flex-1" disabled={saving} onClick={() => void withSaving(async () => {
                await api.post(`/purchases/${voidTarget.id}/void`, { reason: voidReason });
                toast.success(t('voided'));
                setVoidTarget(null);
              })}>{t('voidPurchase')}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
