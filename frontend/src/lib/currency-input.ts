export type CurrencyAmountTarget = 'payment' | 'wallet' | 'discount';
export type CurrencyDiscountType = 'percentage' | 'amount';

export function getDiscountInputStep(maxDecimals: number, discountType: CurrencyDiscountType): string {
  return discountType === 'percentage' || maxDecimals === 0 ? '1' : '0.01';
}

export function normalizeFixedDiscountValue(value: number, maxDecimals: number): number {
  return roundCurrencyValue(value, maxDecimals === 0 ? 0 : 2);
}

export function roundCurrencyValue(value: number, maxDecimals: number): number {
  const decimals = Math.max(0, maxDecimals);
  const epsilon = Number.EPSILON * Math.max(1, Math.abs(value));
  const adjustedValue = value < 0 ? value - epsilon : value + epsilon;
  return Number(adjustedValue.toFixed(decimals));
}

export function allowCurrencyDecimalKey(
  maxDecimals: number,
  amountTarget: CurrencyAmountTarget,
  discountType: CurrencyDiscountType,
): boolean {
  return (amountTarget === 'discount' && discountType === 'percentage') || maxDecimals > 0;
}

/**
 * Parsea un importe escrito por el operador respetando los decimales de la moneda.
 *
 * En monedas sin decimales (COP, CLP) el punto y la coma sólo pueden ser
 * separadores de miles, así que se descartan: "104.000" son ciento cuatro mil.
 * En monedas con decimales el separador es ambiguo, de modo que sólo se acepta
 * el punto decimal y se rechaza cualquier otra cosa en vez de adivinar.
 *
 * Devuelve null cuando el texto no es un importe válido.
 */
export function parseCurrencyAmountInput(raw: string, maxDecimals: number): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  if (maxDecimals === 0) {
    const digitsOnly = trimmed.replace(/[.,\s\u00a0]/g, '');
    if (!/^\d+$/.test(digitsOnly)) return null;
    const value = Number(digitsOnly);
    return Number.isFinite(value) ? value : null;
  }

  if (!new RegExp('^\\d+(?:\\.\\d{1,' + maxDecimals + '})?$').test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}
