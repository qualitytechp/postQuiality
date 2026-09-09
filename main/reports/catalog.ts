/**
 * Lista blanca del generador de reportes.
 *
 * Regla única e innegociable: **nada que venga del cliente entra en el SQL**.
 * El cliente manda identificadores (`net_sales`, `category`, `order_type`) y
 * este catálogo los traduce a expresiones escritas aquí. Un identificador que
 * no esté en el catálogo se rechaza; no hay ruta alternativa.
 *
 * Los valores de filtro sí viajan como parámetros vinculados, nunca
 * interpolados.
 */

/** Nivel de la fila sobre la que agrega una dimensión o medida. */
export type ReportLevel = 'bill' | 'item';

export interface DimensionDef {
  id: string;
  level: ReportLevel;
  /** Expresión SQL para agrupar. */
  sql: string;
  /** Expresión para la etiqueta legible; por defecto, la misma que `sql`. */
  labelSql?: string;
  /** Orden por defecto cuando esta dimensión encabeza el reporte. */
  defaultSort?: 'asc' | 'desc';
}

export interface MeasureDef {
  id: string;
  /** Expresión a nivel de factura. */
  billSql: string;
  /**
   * Expresión cuando el reporte baja a nivel de ítem. El dinero de la factura
   * se reparte por participación del ítem en el subtotal del pedido: es una
   * estimación, y la interfaz debe declararlo.
   */
  itemSql?: string;
  /** Medida derivada de otras dos, calculada tras agregar. */
  ratioOf?: [string, string];
  format: 'money' | 'count' | 'duration';
}

/** Reparto del importe de la factura entre los ítems del pedido. */
const ALLOC = `(CAST(oi.subtotal AS REAL) / NULLIF(o.subtotal, 0))`;

export const DIMENSIONS: Record<string, DimensionDef> = {
  day: { id: 'day', level: 'bill', sql: `date(b.paid_at)`, defaultSort: 'asc' },
  month: { id: 'month', level: 'bill', sql: `strftime('%Y-%m', b.paid_at)`, defaultSort: 'asc' },
  week: { id: 'week', level: 'bill', sql: `strftime('%Y-W%W', b.paid_at)`, defaultSort: 'asc' },
  hour: { id: 'hour', level: 'bill', sql: `strftime('%H', b.paid_at)`, defaultSort: 'asc' },
  weekday: { id: 'weekday', level: 'bill', sql: `strftime('%w', b.paid_at)`, defaultSort: 'asc' },

  order_type: { id: 'order_type', level: 'bill', sql: `o.type` },
  online_platform: { id: 'online_platform', level: 'bill', sql: `COALESCE(o.online_platform, '')` },
  staff: { id: 'staff', level: 'bill', sql: `o.user_id`, labelSql: `COALESCE(u.name, o.user_id)` },
  role: { id: 'role', level: 'bill', sql: `COALESCE(u.role, '')` },
  table: { id: 'table', level: 'bill', sql: `COALESCE(o.table_id, '')`, labelSql: `COALESCE(t.number, t.name, '')` },
  customer: { id: 'customer', level: 'bill', sql: `COALESCE(o.customer_id, '')`, labelSql: `COALESCE(c.name, '')` },

  product: { id: 'product', level: 'item', sql: `oi.product_id`, labelSql: `oi.product_name` },
  category: { id: 'category', level: 'item', sql: `COALESCE(p.category_id, '')`, labelSql: `COALESCE(cat.name, '')` },
};

export const MEASURES: Record<string, MeasureDef> = {
  gross_sales: {
    id: 'gross_sales',
    billSql: `SUM(b.paid_amount)`,
    itemSql: `SUM(b.paid_amount * ${ALLOC})`,
    format: 'money',
  },
  subtotal: {
    id: 'subtotal',
    billSql: `SUM(b.subtotal)`,
    itemSql: `SUM(oi.subtotal)`,
    format: 'money',
  },
  tax: {
    id: 'tax',
    billSql: `SUM(b.tax_amount)`,
    itemSql: `SUM(oi.tax_amount)`,
    format: 'money',
  },
  discount: {
    id: 'discount',
    billSql: `SUM(b.discount_amount)`,
    itemSql: `SUM(b.discount_amount * ${ALLOC})`,
    format: 'money',
  },
  service_charge: {
    id: 'service_charge',
    billSql: `SUM(b.service_charge)`,
    itemSql: `SUM(b.service_charge * ${ALLOC})`,
    format: 'money',
  },
  delivery_charge: {
    id: 'delivery_charge',
    billSql: `SUM(b.delivery_charge)`,
    itemSql: `SUM(b.delivery_charge * ${ALLOC})`,
    format: 'money',
  },
  packaging_charge: {
    id: 'packaging_charge',
    billSql: `SUM(b.packaging_charge)`,
    itemSql: `SUM(b.packaging_charge * ${ALLOC})`,
    format: 'money',
  },
  bill_count: {
    id: 'bill_count',
    billSql: `COUNT(DISTINCT b.id)`,
    itemSql: `COUNT(DISTINCT b.id)`,
    format: 'count',
  },
  order_count: {
    id: 'order_count',
    billSql: `COUNT(DISTINCT o.id)`,
    itemSql: `COUNT(DISTINCT o.id)`,
    format: 'count',
  },
  item_count: {
    id: 'item_count',
    billSql: `0`,
    itemSql: `SUM(oi.quantity)`,
    format: 'count',
  },
  avg_ticket: {
    id: 'avg_ticket',
    billSql: `0`,
    ratioOf: ['gross_sales', 'bill_count'],
    format: 'money',
  },
};

export interface FilterFieldDef {
  id: string;
  sql: string;
  type: 'text' | 'number' | 'date';
  level: ReportLevel;
}

export const FILTER_FIELDS: Record<string, FilterFieldDef> = {
  order_type: { id: 'order_type', sql: `o.type`, type: 'text', level: 'bill' },
  online_platform: { id: 'online_platform', sql: `o.online_platform`, type: 'text', level: 'bill' },
  staff: { id: 'staff', sql: `o.user_id`, type: 'text', level: 'bill' },
  table: { id: 'table', sql: `o.table_id`, type: 'text', level: 'bill' },
  customer: { id: 'customer', sql: `o.customer_id`, type: 'text', level: 'bill' },
  bill_total: { id: 'bill_total', sql: `b.paid_amount`, type: 'number', level: 'bill' },
  product: { id: 'product', sql: `oi.product_id`, type: 'text', level: 'item' },
  category: { id: 'category', sql: `p.category_id`, type: 'text', level: 'item' },
};

/** Operadores permitidos por tipo. La comparación se hace con parámetros. */
export const OPERATORS: Record<string, { sql: string; types: FilterFieldDef['type'][] }> = {
  eq: { sql: '=', types: ['text', 'number', 'date'] },
  ne: { sql: '!=', types: ['text', 'number', 'date'] },
  gt: { sql: '>', types: ['number', 'date'] },
  gte: { sql: '>=', types: ['number', 'date'] },
  lt: { sql: '<', types: ['number', 'date'] },
  lte: { sql: '<=', types: ['number', 'date'] },
  in: { sql: 'IN', types: ['text'] },
};

export const MAX_DIMENSIONS = 2;
export const MAX_FILTERS = 10;
export const MAX_ROWS = 1000;
