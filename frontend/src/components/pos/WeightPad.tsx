'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'use-intl';
import TouchNumberPad from '@/components/pos/TouchNumberPad';
import { Ltr } from '@/components/layout/Ltr';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import {
  acceptsWeightKeystroke,
  clampWeightValue,
  maxWeightFor,
  parseWeightInput,
  quickWeightValues,
} from '@/lib/weight-input';

interface Props {
  /** Unidad de venta del producto: kg, g o lb. */
  unit: string;
  /** Decimales admitidos, ya acotados por `clampWeightPrecision`. */
  precision: number;
  /** Precio por unidad de peso, ya con las adiciones incluidas. */
  unitPrice: number;
  value: string;
  onChange: (value: string) => void;
}

/**
 * Teclado para escribir el peso leído en la balanza, con el cálculo a la vista
 * para que el cajero pueda contrastarlo antes de cobrar.
 */
export default function WeightPad({ unit, precision, unitPrice, value, onChange }: Props) {
  const t = useTranslations('pos');
  const tProducts = useTranslations('products');
  const fmt = useFormatCurrency();
  const inputRef = useRef<HTMLInputElement>(null);

  const unitLabel = tProducts(`saleUnit${unit.charAt(0).toUpperCase()}${unit.slice(1)}` as never);
  const weight = parseWeightInput(value, precision);
  const lineTotal = weight === null ? 0 : unitPrice * weight;

  // Sólo al montar: el modal es una instancia nueva por cada producto que se
  // abre, así que esto es exactamente "al abrir", sin robarle el foco al
  // cajero mientras ya está escribiendo.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleTyped = (raw: string) => {
    if (!acceptsWeightKeystroke(raw, precision)) return;
    onChange(clampWeightValue(raw, maxWeightFor(unit)));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border border-border bg-muted/40 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="weight-pad-input" className="text-sm text-muted-foreground">{t('weight')}</label>
          <div className="flex items-baseline gap-1.5">
            <input
              id="weight-pad-input"
              ref={inputRef}
              type="text"
              inputMode="decimal"
              dir="ltr"
              value={value}
              onChange={(e) => handleTyped(e.target.value)}
              placeholder="0"
              className="w-24 bg-transparent text-end text-2xl font-bold tabular-nums text-foreground outline-none placeholder:text-muted-foreground/50"
            />
            <span className="text-sm text-muted-foreground"><Ltr>{unitLabel}</Ltr></span>
          </div>
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-border pt-2">
          <span className="ltr-island text-xs text-muted-foreground">
            <Ltr>{fmt(unitPrice)}/{unitLabel}</Ltr>
          </span>
          <span className="ltr-island text-lg font-bold tabular-nums text-brand">
            <Ltr>{fmt(lineTotal)}</Ltr>
          </span>
        </div>
      </div>

      <TouchNumberPad
        value={value}
        onChange={handleTyped}
        ariaLabel={t('numericKeypad')}
        clearLabel={t('clearWeight')}
        backspaceLabel={t('backspaceWeight')}
        allowDecimal={precision > 0}
        max={maxWeightFor(unit)}
        quickValues={quickWeightValues(unit).map((quick) => ({ label: `${quick} ${unitLabel}`, value: quick }))}
      />
    </div>
  );
}
