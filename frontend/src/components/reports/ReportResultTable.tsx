'use client';

import { ArrowDown, ArrowUp } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import type { ReportBuilderModel } from '@/hooks/useReportBuilder';

/** Tabla del resultado, ordenable, con la fila de totales al pie. */
export function ReportResultTable({ model }: { model: ReportBuilderModel }) {
  const t = useTranslations('reports');
  const fmt = useFormatCurrency();
  const { result, definition, columns, sortBy } = model;
  if (!result) return null;

  const label = (id: string, kind: string) =>
    (kind === 'dimension' ? t(`dimensions.${id}` as never) : t(`measures.${id}` as never));

  const show = (value: number, format?: string) =>
    (format === 'money' ? fmt(value) : Math.round(value).toLocaleString());

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full min-w-[32rem] border-collapse text-sm">
        <thead>
          <tr>
            {columns.map((c) => {
              const active = definition.sort?.key === c.id;
              return (
                <th
                  key={c.id}
                  scope="col"
                  className={`border-b border-border px-3 py-2 font-semibold text-muted-foreground ${
                    c.kind === 'measure' ? 'text-end' : 'text-start'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => sortBy(c.id)}
                    className={`inline-flex items-center gap-1 hover:text-foreground ${active ? 'text-foreground' : ''}`}
                  >
                    {label(c.id, c.kind)}
                    {active && (definition.sort?.direction === 'asc'
                      ? <ArrowUp size={12} />
                      : <ArrowDown size={12} />)}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i} className="hover:bg-muted/40">
              {columns.map((c) => (
                <td
                  key={c.id}
                  className={`border-b border-border px-3 py-2 ${
                    c.kind === 'measure' ? 'text-end tabular-nums' : 'text-start'
                  }`}
                >
                  {c.kind === 'dimension'
                    ? (row.dimensions[c.id]?.label || row.dimensions[c.id]?.key || '—')
                    : <Ltr>{show(row.values[c.id] ?? 0, c.format)}</Ltr>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            {columns.map((c, i) => (
              <td
                key={c.id}
                className={`px-3 py-2 ${c.kind === 'measure' ? 'text-end tabular-nums' : 'text-start'}`}
              >
                {c.kind === 'dimension'
                  ? (i === 0 ? t('total') : '')
                  : <Ltr>{show(result.totals[c.id] ?? 0, c.format)}</Ltr>}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
