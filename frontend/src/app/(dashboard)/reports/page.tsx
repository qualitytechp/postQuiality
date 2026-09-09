'use client';

import { BarChart3, Download, LineChart, Loader2, Table2, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import { useReportBuilder } from '@/hooks/useReportBuilder';
import { ReportBuilderPanel } from '@/components/reports/ReportBuilderPanel';
import { ReportResultTable } from '@/components/reports/ReportResultTable';
import { ReportChart } from '@/components/reports/ReportChart';
import { SavedReportsMenu } from '@/components/reports/SavedReportsMenu';
import { CashRegisterReport } from '@/components/reports/CashRegisterReport';

export default function ReportsPage() {
  const t = useTranslations('reports');
  const model = useReportBuilder();
  const [tab, setTab] = useState<'builder' | 'register'>('builder');
  const { view, setView, loading, error, valid, result, exportCsv, setPeriod, definition } = model;

  const views: { id: typeof view; label: string; icon: typeof Table2 }[] = [
    { id: 'table', label: t('viewTable'), icon: Table2 },
    { id: 'bars', label: t('viewBars'), icon: BarChart3 },
    { id: 'lines', label: t('viewLines'), icon: LineChart },
  ];

  return (
    <div className="p-6">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {tab === 'builder' && (
          <div className="flex flex-wrap items-center gap-2">
            <SavedReportsMenu model={model} />
            <Button variant="outline" size="sm" onClick={() => { void exportCsv(); }} disabled={!valid || !result} className="h-9">
              <Download size={14} />
              {t('exportCsv')}
            </Button>
          </div>
        )}
      </div>

      <div className="mb-4 flex gap-1.5">
        {([
          { id: 'builder' as const, label: t('tabBuilder'), icon: BarChart3 },
          { id: 'register' as const, label: t('tabRegister'), icon: Wallet },
        ]).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            aria-pressed={tab === id}
            className={`flex min-h-9 items-center gap-1.5 rounded-lg border px-3 text-sm ${
              tab === id ? 'border-brand bg-brand text-white' : 'border-border bg-card text-foreground hover:border-brand'
            }`}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {tab === 'register' ? <CashRegisterReport /> : (
      <div className="grid gap-4 lg:grid-cols-[17rem_1fr]">
        <aside className="rounded-xl border border-border bg-card p-4 lg:sticky lg:top-6 lg:self-start">
          <ReportBuilderPanel model={model} />
        </aside>

        <section className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-1.5">
              {views.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setView(id)}
                  aria-pressed={view === id}
                  className={`flex min-h-9 items-center gap-1.5 rounded-lg border px-3 text-sm ${
                    view === id
                      ? 'border-brand bg-brand text-white'
                      : 'border-border bg-card text-foreground hover:border-brand'
                  }`}
                >
                  <Icon size={14} />
                  {label}
                </button>
              ))}
            </div>
            {loading && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 size={13} className="animate-spin" />
                {t('calculating')}
              </span>
            )}
          </div>

          {!valid ? (
            <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              {t('pickMeasure')}
            </p>
          ) : error ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-8 text-center dark:border-red-900 dark:bg-red-950/30">
              <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
              <Button variant="outline" size="sm" onClick={() => setPeriod(definition.from, definition.to)}>
                {t('retry')}
              </Button>
            </div>
          ) : result && result.rows.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              {t('noData')}
            </p>
          ) : (
            // El resultado anterior permanece atenuado mientras llega el nuevo:
            // la pantalla nunca se vacía entre consultas.
            <div className={loading ? 'opacity-50 transition-opacity' : 'transition-opacity'}>
              {view !== 'table' && <ReportChart model={model} />}
              <div className={view !== 'table' ? 'mt-3' : ''}>
                <ReportResultTable model={model} />
              </div>
              {result?.allocated && (
                <p className="mt-2 text-xs text-muted-foreground">{t('allocatedNote')}</p>
              )}
            </div>
          )}
        </section>
      </div>
      )}
    </div>
  );
}
