/**
 * Entrada de peso para productos vendidos por kilo, gramo o libra.
 *
 * Es la única puerta por la que un peso entra al carrito escrito a mano. Una
 * balanza conectada debe alimentar `parseWeightInput` en vez de abrir su propio
 * camino, para que el redondeo y los límites sigan siendo los mismos.
 */
import type { Product } from '@/lib/types';

export const WEIGHT_SALE_UNITS = ['kg', 'g', 'lb'] as const;
export type WeightSaleUnit = (typeof WEIGHT_SALE_UNITS)[number];

type WeighedFields = Pick<Product, 'sale_unit' | 'allow_fractional_quantity' | 'weight_precision'>;

/** El backend exige ambas condiciones para aceptar cantidades decimales. */
export function isWeighedProduct(product: Partial<WeighedFields> | null | undefined): boolean {
  if (!product) return false;
  return Boolean(product.allow_fractional_quantity)
    && WEIGHT_SALE_UNITS.includes(product.sale_unit as WeightSaleUnit);
}

/** Misma horquilla que `validateProductQuantity` en el backend. */
export function clampWeightPrecision(precision: number | null | undefined): number {
  if (!Number.isInteger(precision)) return 3;
  return Math.min(Math.max(Number(precision), 0), 4);
}

// Tope de cordura contra dedazos (un "5" de más), no una regla de negocio.
const MAX_WEIGHT: Record<WeightSaleUnit, number> = { kg: 999, g: 999_000, lb: 999 };

export function maxWeightFor(unit: string): number {
  return MAX_WEIGHT[unit as WeightSaleUnit] ?? 999;
}

/**
 * Decide si el texto tecleado sigue siendo escribible. Se comprueba al vuelo
 * para que el teclado no acepte más decimales de los que el producto admite.
 */
export function acceptsWeightKeystroke(raw: string, precision: number): boolean {
  if (raw === '' || raw === '.') return true;
  if (!/^\d*\.?\d*$/.test(raw)) return false;
  const decimals = raw.split('.')[1];
  if (decimals === undefined) return true;
  if (precision === 0) return false;
  return decimals.length <= precision;
}

/**
 * Recorta al tope de cordura de la unidad. El teclado táctil ya lo aplica
 * dígito a dígito (`TouchNumberPad`); el teclado físico entra por su propio
 * campo de texto y necesita el mismo recorte para no dejarlo pasar.
 */
export function clampWeightValue(raw: string, max: number): string {
  if (raw === '' || raw === '.') return raw;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return raw;
  return numeric > max ? String(max) : raw;
}

/**
 * Devuelve el peso listo para enviar, o null si aún no es un número usable.
 *
 * Redondea en vez de rechazar cuando sobran decimales: el teclado ya impide
 * teclearlos, así que ese caso sólo llega desde una balanza, y una lectura de
 * 0,7532 kg debe convertirse en 0,753 y no perderse.
 */
export function parseWeightInput(raw: string, precision: number): number | null {
  if (typeof raw !== 'string' || !/^\d*\.?\d*$/.test(raw) || raw === '' || raw === '.') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  // Se comprueba tras redondear: 0,001 sobre un producto sin decimales queda en
  // cero, y una cantidad cero no es una venta.
  const rounded = Number(value.toFixed(precision));
  return rounded > 0 ? rounded : null;
}

/** Atajos habituales de mostrador, en la unidad del producto. */
export function quickWeightValues(unit: string): string[] {
  if (unit === 'g') return ['100', '250', '500', '1000'];
  if (unit === 'lb') return ['0.5', '1', '2', '5'];
  return ['0.25', '0.5', '1', '2'];
}

/** Presenta el peso con los decimales del producto y el separador local. */
export function formatWeight(value: number, precision: number, locale?: string): string {
  return value.toLocaleString(locale, {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}
