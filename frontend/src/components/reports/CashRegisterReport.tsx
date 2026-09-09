'use client';

import { useCallback, useEffect, useState } from 'react';
import { LockOpen, Pencil, Wallet } from 'lucide-react';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Ltr } from '@/components/layout/Ltr';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { getCurrencyMinorUnitFactor } from '@/lib/countries';
import { useAuthStore } from '@/store/auth';

interface OpenSession {
  id: number;
  openedAt: string;
  openedByName: string | null;
  openingFloatCents: number;
}

interface Closure {
  id: number;
  z_number: number;
  scope: 'day' | 'session';
  business_date: string;
  period_start: string;
  period_end: string;
  opening_float_cents: number;
  expected_cash_cents: number;
  counted_cash_cents: number;
  variance_cents: number;
  gross_collected_cents: number;
  bill_count: number;
  closed_by_name: string | null;
  opened_by_name: string | null;
  amendment_count: number;
}

/** Una cifra con su etiqueta, en la caja del estado actual. */
function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`ltr-island tabular-nums ${strong ? 'text-lg font-bold' : 'text-base font-semibold'} text-foreground`}>
        <Ltr>{value}</Ltr>
      </p>
    </div>
  );
}

/**
 * Estado de la caja en curso y el histórico de cierres.
 *
 * El estado en curso sale del reporte X, que ya conoce la caja abierta y
 * agrega sólo su ventana; el histórico de `GET /api/cash-closures`.
 */
export function CashRegisterReport() {
  const t = useTranslations('reports');
  const fmt = useFormatCurrency();
  const currency = useAuthStore((s) => s.currentTenant?.currency) ?? 'INR';
  const minorFactor = getCurrencyMinorUnitFactor(currency);

  const [session, setSession] = useState<OpenSession | null>(null);
  const [expectedCents, setExpectedCents] = useState(0);
  const [closures, setClosures] = useState<Closure[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const money = (cents: number) => fmt(cents / minorFactor);

  const loadCurrent = useCallback(() => {
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    api.get('/reports/x-report', { params: { date: iso } })
      .then((res) => {
        const x = res.data?.xReport;
        setSession(x?.openSession ?? null);
        // El X ya devuelve el efectivo esperado de la ventana abierta.
        setExpectedCents(Number(x?.expectedCashCents ?? 0) + Number(x?.openSession?.openingFloatCents ?? 0));
      })
      .catch(() => setSession(null));
  }, []);

  const loadHistory = useCallback((offset: number) => {
    api.get('/cash-closures', { params: { offset, per_page: 20 } })
      .then((res) => {
        setClosures((prev) => (offset === 0 ? res.data.closures : [...prev, ...res.data.closures]));
        setHasMore(Boolean(res.data.pagination?.has_more));
      })
      .catch(() => { if (offset === 0) setClosures([]); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadCurrent(); loadHistory(0); }, [loadCurrent, loadHistory]);

  const openedAt = session ? new Date(session.openedAt.replace(' ', 'T') + 'Z') : null;
  const elapsedMs = openedAt ? nowMs - openedAt.getTime() : 0;
  const hours = Math.max(0, Math.floor(elapsedMs / 3_600_000));
  const minutes = Math.max(0, Math.floor((elapsedMs % 3_600_000) / 60_000));
  const soldCents = session ? expectedCents - session.openingFloatCents : 0;

  const measureLabel = (id: string) => t(`measures.${id}` as never);

  const cell = 'border-b border-border px-3 py-2';

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-3 flex items-center gap-2 font-semibold text-foreground">
          <Wallet size={16} />
          {t('registerNow')}
        </h2>
        {session ? (
          <>
            <p className="mb-3 text-sm text-muted-foreground">
              {t('openedBy', {
                name: session.openedByName ?? '—',
                time: openedAt ? openedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—',
              })}
              {' · '}
              {t('elapsed', { hours, minutes })}
            </p>
            <div className="grid gap-2 sm:grid-cols-3">
              <Figure label={t('startedWith')} value={money(session.openingFloatCents)} />
              <Figure label={t('salesSinceOpen')} value={money(soldCents)} />
              <Figure label={t('expectedNow')} value={money(expectedCents)} strong />
            </div>
          </>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LockOpen size={14} />
            {t('noRegisterOpen')}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold text-foreground">{t('closureHistory')}</h2>
        {closures.length === 0 && !loading ? (
          <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            {t('noClosures')}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full min-w-[46rem] border-collapse text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className={`${cell} text-start`}>{t('zNumber')}</th>
                  <th scope="col" className={`${cell} text-start`}>{t('shift')}</th>
                  <th scope="col" className={`${cell} text-end`}>{t('startedWith')}</th>
                  <th scope="col" className={`${cell} text-end`}>{measureLabel('gross_sales')}</th>
                  <th scope="col" className={`${cell} text-end`}>{t('counted')}</th>
                  <th scope="col" className={`${cell} text-end`}>{measureLabel('bill_count')}</th>
                  <th scope="col" className={`${cell} text-start`}>{t('closedBy')}</th>
                </tr>
              </thead>
              <tbody>
                {closures.map((c) => (
                  <tr key={c.id} className="hover:bg-muted/40">
                    <td className={`${cell} font-semibold`}>
                      <Ltr>#{c.z_number}</Ltr>
                      {c.amendment_count > 0 && (
                        <span className="ms-2 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                          <Pencil size={9} />
                          {t('amended')}
                        </span>
                      )}
                    </td>
                    <td className={cell}>
                      <span className="block"><Ltr>{c.business_date}</Ltr></span>
                      <span className="text-xs text-muted-foreground">
                        {c.scope === 'session' ? t('shiftScope') : t('dayScope')}
                        {c.opened_by_name ? ` · ${c.opened_by_name}` : ''}
                      </span>
                    </td>
                    <td className={`${cell} text-end tabular-nums`}><Ltr>{money(c.opening_float_cents)}</Ltr></td>
                    <td className={`${cell} text-end tabular-nums`}><Ltr>{money(c.gross_collected_cents)}</Ltr></td>
                    <td className={`${cell} text-end tabular-nums`}>
                      <span className="block"><Ltr>{money(c.counted_cash_cents)}</Ltr></span>
                      {c.variance_cents !== 0 && (
                        <span className={`text-xs ${c.variance_cents < 0 ? 'text-red-600' : 'text-amber-600'}`}>
                          <Ltr>{money(c.variance_cents)}</Ltr>
                        </span>
                      )}
                    </td>
                    <td className={`${cell} text-end tabular-nums`}><Ltr>{String(c.bill_count)}</Ltr></td>
                    <td className={cell}>{c.closed_by_name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {hasMore && (
          <Button variant="outline" size="sm" className="self-start" onClick={() => loadHistory(closures.length)}>
            {t('loadMore')}
          </Button>
        )}
      </section>
    </div>
  );
}
