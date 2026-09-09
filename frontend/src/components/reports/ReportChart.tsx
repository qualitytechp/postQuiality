'use client';

import { useTranslations } from 'use-intl';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import type { ReportBuilderModel } from '@/hooks/useReportBuilder';

/**
 * Barras o líneas sobre el mismo resultado que alimenta la tabla, nunca sobre
 * datos aparte. Se dibuja en SVG con la escala del propio resultado: cada
 * etiqueta nombra un valor que la gráfica alcanza.
 */
export function ReportChart({ model }: { model: ReportBuilderModel }) {
  const t = useTranslations('reports');
  const fmt = useFormatCurrency();
  const { result, definition, view, columns } = model;
  if (!result || result.rows.length === 0) return null;

  const dimension = definition.dimensions[0];
  const measureCol = columns.find((c) => c.kind === 'measure');
  if (!dimension || !measureCol) return null;

  const rows = result.rows.slice(0, 24);
  const values = rows.map((r) => r.values[measureCol.id] ?? 0);
  const max = Math.max(...values, 1);

  const show = (v: number) => (measureCol.format === 'money' ? fmt(v) : Math.round(v).toLocaleString());

  const W = 720;
  const H = 220;
  const padX = 8;
  const padBottom = 34;
  const usableH = H - padBottom - 8;
  const step = (W - padX * 2) / rows.length;

  return (
    <figure className="rounded-xl border border-border bg-card p-4">
      <figcaption className="sr-only">
        {t(`measures.${measureCol.id}` as never)} — {t(`dimensions.${dimension}` as never)}
      </figcaption>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" className="min-w-[28rem]">
          <line x1={padX} y1={H - padBottom} x2={W - padX} y2={H - padBottom} stroke="currentColor" className="text-border" strokeWidth="1" />
          {view === 'bars' ? rows.map((row, i) => {
            const h = Math.max(2, (values[i] / max) * usableH);
            return (
              <rect
                key={i}
                x={padX + i * step + step * 0.18}
                y={H - padBottom - h}
                width={step * 0.64}
                height={h}
                rx="2"
                className="fill-brand"
              />
            );
          }) : (
            <polyline
              fill="none"
              strokeWidth="2"
              className="stroke-brand"
              points={rows.map((_, i) => {
                const x = padX + i * step + step / 2;
                const y = H - padBottom - Math.max(2, (values[i] / max) * usableH);
                return `${x},${y}`;
              }).join(' ')}
            />
          )}
          {rows.map((row, i) => (
            <text
              key={`l${i}`}
              x={padX + i * step + step / 2}
              y={H - padBottom + 14}
              textAnchor="middle"
              className="fill-current text-[10px] text-muted-foreground"
            >
              {(row.dimensions[dimension]?.label || row.dimensions[dimension]?.key || '—').slice(0, 10)}
            </text>
          ))}
          <text x={padX} y={14} className="fill-current text-[11px] text-muted-foreground">
            {show(max)}
          </text>
        </svg>
      </div>
    </figure>
  );
}
