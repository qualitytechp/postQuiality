'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'use-intl';
import type { ReportCatalog, ReportFilter } from '@/hooks/useReportBuilder';

interface Props {
  filter: ReportFilter;
  catalog: ReportCatalog | null;
  onChange: (next: ReportFilter) => void;
  onRemove: () => void;
}

/**
 * Una fila de filtro: campo, operador y valor.
 *
 * Los operadores se limitan a los que el tipo del campo admite —no tiene
 * sentido "mayor que" sobre un tipo de pedido— y el control del valor cambia
 * con el tipo.
 */
export function ReportFilterRow({ filter, catalog, onChange, onRemove }: Props) {
  const t = useTranslations('reports');

  const fields = catalog?.filterFields ?? [];
  const field = fields.find((f) => f.id === filter.field);
  const operators = (catalog?.operators ?? []).filter((o) => !field || o.types.includes(field.type));

  const labelFor = (id: string) => {
    // Muchos campos de filtro comparten nombre con una dimensión; se reutiliza
    // su etiqueta y sólo los propios del filtro tienen la suya.
    const asDimension = (catalog?.dimensions ?? []).some((d) => d.id === id);
    return asDimension ? t(`dimensions.${id}` as never) : t(`filterFields.${id}` as never);
  };

  const control = 'h-9 rounded-lg border border-border bg-background px-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-brand/30';

  return (
    <div className="flex items-center gap-1.5">
      <select
        value={filter.field}
        onChange={(e) => {
          const next = fields.find((f) => f.id === e.target.value);
          const allowed = (catalog?.operators ?? []).filter((o) => !next || o.types.includes(next.type));
          const keepOperator = allowed.some((o) => o.id === filter.operator);
          onChange({
            field: e.target.value,
            operator: keepOperator ? filter.operator : (allowed[0]?.id ?? 'eq'),
            value: '',
          });
        }}
        className={`${control} min-w-0 flex-1`}
      >
        {fields.map((f) => <option key={f.id} value={f.id}>{labelFor(f.id)}</option>)}
      </select>

      <select
        value={filter.operator}
        onChange={(e) => onChange({ ...filter, operator: e.target.value })}
        className={`${control} w-28 shrink-0`}
      >
        {operators.map((o) => <option key={o.id} value={o.id}>{t(`operators.${o.id}` as never)}</option>)}
      </select>

      <input
        type={field?.type === 'number' ? 'number' : 'text'}
        inputMode={field?.type === 'number' ? 'decimal' : undefined}
        value={filter.value}
        onChange={(e) => onChange({ ...filter, value: e.target.value })}
        className={`${control} min-w-0 flex-1`}
      />

      <button
        type="button"
        onClick={onRemove}
        aria-label={t('removeFilter')}
        className="touch-target shrink-0 rounded-lg border border-border text-muted-foreground hover:text-foreground"
      >
        <X size={14} />
      </button>
    </div>
  );
}
