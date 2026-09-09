'use client';

import { Plus } from 'lucide-react';
import { useTranslations } from 'use-intl';
import type { ReportBuilderModel } from '@/hooks/useReportBuilder';
import { ReportFilterRow } from './ReportFilterRow';

/** Fichas alternables sobre un catálogo. Al llegar al máximo, lo no elegido se atenúa. */
function ChipGroup({
  ids, selected, onToggle, label, disabledWhenFull,
}: {
  ids: string[];
  selected: string[];
  onToggle: (id: string) => void;
  label: (id: string) => string;
  disabledWhenFull?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {ids.map((id) => {
        const on = selected.includes(id);
        const blocked = Boolean(disabledWhenFull) && !on;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onToggle(id)}
            disabled={blocked}
            aria-pressed={on}
            className={`min-h-9 rounded-full border px-3 text-sm transition-colors ${
              on
                ? 'border-brand bg-brand text-white'
                : blocked
                  ? 'border-border bg-card text-muted-foreground opacity-40'
                  : 'border-border bg-card text-foreground hover:border-brand'
            }`}
          >
            {label(id)}
          </button>
        );
      })}
    </div>
  );
}

/** Columna izquierda: periodo, medidas, agrupaciones y filtros con la misma jerarquía. */
export function ReportBuilderPanel({ model }: { model: ReportBuilderModel }) {
  const t = useTranslations('reports');
  const {
    definition, catalog, maxDimensions,
    toggleMeasure, toggleDimension, setPeriod,
    addFilter, updateFilter, removeFilter,
  } = model;

  const today = new Date();
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const presets: { key: string; label: string; from: string; to: string }[] = [
    { key: 'today', label: t('presetToday'), from: iso(today), to: iso(today) },
    {
      key: 'week',
      label: t('presetWeek'),
      from: iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6)),
      to: iso(today),
    },
    {
      key: 'month',
      label: t('presetMonth'),
      from: iso(new Date(today.getFullYear(), today.getMonth(), 1)),
      to: iso(today),
    },
  ];

  const block = 'flex flex-col gap-2';
  const legend = 'text-xs font-semibold uppercase tracking-wide text-muted-foreground';

  return (
    <div className="flex flex-col gap-5">
      <div className={block}>
        <span className={legend}>{t('period')}</span>
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => {
            const on = definition.from === p.from && definition.to === p.to;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => setPeriod(p.from, p.to)}
                className={`min-h-9 rounded-full border px-3 text-sm ${
                  on ? 'border-brand bg-brand text-white' : 'border-border bg-card text-foreground hover:border-brand'
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('from')}
            <input
              type="date"
              value={definition.from}
              max={definition.to}
              onChange={(e) => e.target.value && setPeriod(e.target.value, definition.to)}
              className="h-9 rounded-lg border border-border bg-background px-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-brand/30"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('to')}
            <input
              type="date"
              value={definition.to}
              min={definition.from}
              onChange={(e) => e.target.value && setPeriod(definition.from, e.target.value)}
              className="h-9 rounded-lg border border-border bg-background px-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-brand/30"
            />
          </label>
        </div>
      </div>

      <div className={block}>
        <span className={legend}>{t('measure')}</span>
        <ChipGroup
          ids={(catalog?.measures ?? []).map((m) => m.id)}
          selected={definition.measures}
          onToggle={toggleMeasure}
          label={(id) => t(`measures.${id}` as never)}
        />
      </div>

      <div className={block}>
        <span className={legend}>{t('groupBy')}</span>
        <ChipGroup
          ids={(catalog?.dimensions ?? []).map((d) => d.id)}
          selected={definition.dimensions}
          onToggle={toggleDimension}
          label={(id) => t(`dimensions.${id}` as never)}
          disabledWhenFull={definition.dimensions.length >= maxDimensions}
        />
        {definition.dimensions.length >= maxDimensions && (
          <p className="text-xs text-muted-foreground">{t('maxDimensions', { count: maxDimensions })}</p>
        )}
      </div>

      <div className={block}>
        <span className={legend}>{t('filters')}</span>
        {definition.filters.map((filter, i) => (
          <ReportFilterRow
            key={i}
            filter={filter}
            catalog={model.catalog}
            onChange={(next) => updateFilter(i, next)}
            onRemove={() => removeFilter(i)}
          />
        ))}
        <button
          type="button"
          onClick={addFilter}
          className="flex min-h-9 items-center gap-1.5 rounded-lg border border-dashed border-border px-3 text-sm text-muted-foreground hover:border-brand hover:text-foreground"
        >
          <Plus size={14} />
          {t('addFilter')}
        </button>
      </div>
    </div>
  );
}
