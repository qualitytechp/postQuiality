'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { Plus, X, Trash2, Ban, Truck, Settings as SettingsIcon } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';

import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore } from '@/store/pos-settings';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatDate } from '@/hooks/useFormatDate';
import { getCurrencyMinorUnitFactor } from '@/lib/countries';

interface Supplier {
  id: string;
  name: string;
  document: string | null;
  phone: string | null;
  is_active: number;
}

interface PurchaseRow {
  id: number;
  purchase_number: string;
  supplier_name: string;
  invoice_ref: string | null;
  total_cents: number;
  balance_cents: number;
  payment_terms: 'cash' | 'credit';
  due_date: string | null;
  status: 'received' | 'void';
  received_at: string;
}

interface ProductOption {
  id: string;
  name: string;
  sale_unit: string;
  track_inventory: number;
}

interface DraftLine {
  key: number;
  product_id: string;
  description: string;
  quantity: string;
  unit_cost: string;
}

const emptyLine = (key: number): DraftLine => ({
  key, product_id: '', description: '', quantity: '', unit_cost: '',
});

export default function PurchasesPage() {
  const t = useTranslations('purchases');
  const tCommon = useTranslations('common');
  const { currentTenant } = useAuthStore();
  const modules = usePosSettingsStore((s) => s.modules);
  const fmt = useFormatCurrency();
  const { formatDate } = useFormatDate();

  // Storage factor, not display decimals: what the API counts in.
  const minorFactor = getCurrencyMinorUnitFactor(currentTenant?.currency || 'INR');

  const [purchases, setPurchases] = useState<PurchaseRow[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const [showPurchaseForm, setShowPurchaseForm] = useState(false);
  const [showSupplierForm, setShowSupplierForm] = useState(false);
  const [voidTarget, setVoidTarget] = useState<PurchaseRow | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [saving, setSaving] = useState(false);

  const [supplierForm, setSupplierForm] = useState({ name: '', document: '', phone: '', address: '' });
  const [nextLineKey, setNextLineKey] = useState(1);
  const [form, setForm] = useState({
    supplier_id: '', invoice_ref: '', payment_terms: 'cash' as 'cash' | 'credit',
    due_date: '', notes: '',
  });
  const [lines, setLines] = useState<DraftLine[]>([emptyLine(0)]);

  const moduleOn = modules?.purchases;
  // Derivado y no un setState dentro del efecto: con el módulo apagado no se
  // carga nada, así que no hay nada que esperar.
  const loading = !!moduleOn && !loaded;

  useEffect(() => {
    if (!moduleOn) return;
    let active = true;
    Promise.all([
      api.get('/purchases', { params: { limit: 100 } }),
      api.get('/suppliers'),
      api.get('/products', { params: { limit: 500 } }),
    ])
      .then(([p, s, pr]) => {
        if (!active) return;
        setPurchases(p.data.purchases || []);
        setSuppliers(s.data.suppliers || []);
        setProducts(pr.data.data || pr.data.products || []);
      })
      .catch(() => { if (active) toast.error(t('loadFailed')); })
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [moduleOn, refreshKey, t]);

  const productById = useMemo(
    () => new Map(products.map((p) => [p.id, p])),
    [products],
  );

  const lineTotalCents = useCallback((line: DraftLine) => {
    const quantity = Number(line.quantity);
    const unitCost = Number(line.unit_cost);
    if (!Number.isFinite(quantity) || !Number.isFinite(unitCost)) return 0;
    return Math.round(quantity * Math.round(unitCost * minorFactor));
  }, [minorFactor]);

  const draftTotalCents = useMemo(
    () => lines.reduce((sum, line) => sum + lineTotalCents(line), 0),
    [lines, lineTotalCents],
  );

  const resetPurchaseForm = () => {
    setForm({ supplier_id: '', invoice_ref: '', payment_terms: 'cash', due_date: '', notes: '' });
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

  const saveSupplier = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!supplierForm.name.trim()) { toast.error(t('supplierNameRequired')); return; }
    setSaving(true);
    try {
      await api.post('/suppliers', supplierForm);
      toast.success(t('supplierSaved'));
      setSupplierForm({ name: '', document: '', phone: '', address: '' });
      setShowSupplierForm(false);
      setRefreshKey((key) => key + 1);
    } catch {
      toast.error(tCommon('somethingWrong'));
    } finally {
      setSaving(false);
    }
  };

  const savePurchase = async (event: React.FormEvent) => {
    event.preventDefault();
    const usable = lines.filter((line) => Number(line.quantity) > 0);
    if (usable.length === 0) { toast.error(t('needsOneLine')); return; }
    if (form.payment_terms === 'credit' && !form.due_date) { toast.error(t('dueDateRequired')); return; }

    setSaving(true);
    try {
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
          unit_cost_cents: Math.round(Number(line.unit_cost) * minorFactor),
        })),
      });
      toast.success(t('saved'));
      resetPurchaseForm();
      setShowPurchaseForm(false);
      setRefreshKey((key) => key + 1);
    } catch (error: unknown) {
      const message = (error as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(message || tCommon('somethingWrong'));
    } finally {
      setSaving(false);
    }
  };

  const confirmVoid = async () => {
    if (!voidTarget) return;
    if (!voidReason.trim()) { toast.error(t('voidReasonRequired')); return; }
    setSaving(true);
    try {
      await api.post(`/purchases/${voidTarget.id}/void`, { reason: voidReason });
      toast.success(t('voided'));
      setVoidTarget(null);
      setVoidReason('');
      setRefreshKey((key) => key + 1);
    } catch (error: unknown) {
      const message = (error as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(message || tCommon('somethingWrong'));
    } finally {
      setSaving(false);
    }
  };

  // The route exists in the bundle whether or not the module is on, so anyone
  // typing the URL lands here. Say so plainly instead of showing a blank page.
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

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setShowSupplierForm(true)}>
            <Plus size={16} className="me-1" /> {t('newSupplier')}
          </Button>
          <Button onClick={() => { resetPurchaseForm(); setShowPurchaseForm(true); }} disabled={suppliers.length === 0}>
            <Plus size={16} className="me-1" /> {t('newPurchase')}
          </Button>
        </div>
      </div>

      {suppliers.length === 0 && !loading && (
        <div className="bg-card border border-border rounded-xl p-8 text-center mb-4">
          <p className="font-medium text-foreground">{t('emptySuppliers')}</p>
          <p className="text-sm text-muted-foreground">{t('emptySuppliersHint')}</p>
        </div>
      )}

      <div className="bg-card rounded-xl border border-border overflow-x-auto">
        <table className="w-full min-w-[720px]">
          <thead className="bg-muted">
            <tr>
              <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">{t('columnNumber')}</th>
              <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">{t('columnDate')}</th>
              <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">{t('columnSupplier')}</th>
              <th className="text-end p-4 text-xs font-medium text-muted-foreground uppercase">{t('columnTotal')}</th>
              <th className="text-end p-4 text-xs font-medium text-muted-foreground uppercase">{t('columnBalance')}</th>
              <th className="text-center p-4 text-xs font-medium text-muted-foreground uppercase">{t('columnStatus')}</th>
              <th className="p-4" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {purchases.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="p-10 text-center">
                  <p className="font-medium text-foreground">{t('empty')}</p>
                  <p className="text-sm text-muted-foreground">{t('emptyHint')}</p>
                </td>
              </tr>
            )}
            {purchases.map((row) => (
              <tr key={row.id} className="hover:bg-muted">
                <td className="p-4 font-medium text-foreground whitespace-nowrap tabular-nums">
                  {row.purchase_number}
                  {row.invoice_ref && <p className="text-xs text-muted-foreground">{row.invoice_ref}</p>}
                </td>
                <td className="p-4 text-sm text-muted-foreground whitespace-nowrap">{formatDate(row.received_at)}</td>
                <td className="p-4 text-sm text-foreground">{row.supplier_name}</td>
                <td className="p-4 text-end font-medium whitespace-nowrap tabular-nums">{fmt(row.total_cents / minorFactor)}</td>
                <td className="p-4 text-end whitespace-nowrap tabular-nums">
                  {row.balance_cents > 0
                    ? <span className="text-amber-600 font-semibold">{fmt(row.balance_cents / minorFactor)}</span>
                    : <span className="text-muted-foreground text-sm">{t('paid')}</span>}
                </td>
                <td className="p-4 text-center">
                  <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                    row.status === 'void'
                      ? 'bg-red-100 text-red-800'
                      : 'bg-green-100 text-green-800'
                  }`}>
                    {row.status === 'void' ? t('statusVoid') : t('statusReceived')}
                  </span>
                </td>
                <td className="p-4 text-end">
                  {row.status === 'received' && (
                    <Button variant="ghost" size="sm" onClick={() => { setVoidTarget(row); setVoidReason(''); }}>
                      <Ban size={14} />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showSupplierForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-2xl p-6 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{t('newSupplier')}</h2>
              <button onClick={() => setShowSupplierForm(false)}><X size={20} className="text-muted-foreground" /></button>
            </div>
            <form onSubmit={saveSupplier} className="space-y-3">
              <input type="text" placeholder={t('supplierName')} value={supplierForm.name} required
                onChange={(e) => setSupplierForm({ ...supplierForm, name: e.target.value })}
                className="w-full px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand" />
              <input type="text" placeholder={`${t('document')} (${tCommon('optional')})`} value={supplierForm.document}
                onChange={(e) => setSupplierForm({ ...supplierForm, document: e.target.value })}
                className="w-full px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand" />
              <input type="tel" placeholder={`${t('phone')} (${tCommon('optional')})`} value={supplierForm.phone}
                onChange={(e) => setSupplierForm({ ...supplierForm, phone: e.target.value })}
                className="w-full px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand" />
              <input type="text" placeholder={`${t('address')} (${tCommon('optional')})`} value={supplierForm.address}
                onChange={(e) => setSupplierForm({ ...supplierForm, address: e.target.value })}
                className="w-full px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand" />
              <Button type="submit" className="w-full" disabled={saving}>{tCommon('save')}</Button>
            </form>
          </div>
        </div>
      )}

      {showPurchaseForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center p-6 pb-4 border-b border-border sticky top-0 bg-card">
              <h2 className="text-lg font-bold">{t('newPurchase')}</h2>
              <button onClick={() => setShowPurchaseForm(false)}><X size={20} className="text-muted-foreground" /></button>
            </div>
            <form onSubmit={savePurchase} className="p-6 space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="text-xs font-medium text-muted-foreground uppercase">{t('supplier')}</span>
                  <select value={form.supplier_id} required
                    onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}
                    className="mt-1 w-full px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand">
                    <option value="">—</option>
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
                    <option value="cash">{t('termsCash')}</option>
                    <option value="credit" disabled={!modules?.receivables}>{t('termsCredit')}</option>
                  </select>
                  {!modules?.receivables && (
                    <span className="text-xs text-muted-foreground">{t('creditNeedsReceivables')}</span>
                  )}
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
                          <span className="text-sm font-medium tabular-nums">{fmt(lineTotalCents(line) / minorFactor)}</span>
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

              <div className="flex items-center justify-between border-t border-border pt-4">
                <span className="text-sm font-medium text-muted-foreground uppercase">{t('total')}</span>
                <span className="text-xl font-bold tabular-nums">{fmt(draftTotalCents / minorFactor)}</span>
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
            <p className="text-sm text-muted-foreground mb-1 tabular-nums">{voidTarget.purchase_number}</p>
            <p className="text-sm text-muted-foreground mb-4">{t('voidHint')}</p>
            <textarea value={voidReason} onChange={(e) => setVoidReason(e.target.value)}
              placeholder={t('voidReason')} rows={3}
              className="w-full px-3 py-2 border border-border rounded-lg bg-card outline-none focus:ring-2 focus:ring-brand mb-4" />
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setVoidTarget(null)}>{tCommon('cancel')}</Button>
              <Button className="flex-1" onClick={confirmVoid} disabled={saving}>{t('voidPurchase')}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
