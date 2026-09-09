/**
 * Traduce una definición de reporte a SQL, exclusivamente desde el catálogo.
 *
 * Invariantes:
 *  - Toda expresión SQL sale de `catalog.ts`. Ningún texto del cliente se
 *    concatena: los identificadores se buscan en la lista blanca y los valores
 *    viajan como parámetros vinculados.
 *  - El dinero se mide sobre `bills.paid_at` (el día que se cobró), igual que
 *    el resto de reportes del proyecto, y sólo cuenta lo efectivamente pagado.
 *  - Bajar a nivel de ítem reparte el importe de la factura por participación
 *    en el subtotal del pedido; es una estimación y se declara al llamador.
 */
import {
  DIMENSIONS, MEASURES, FILTER_FIELDS, OPERATORS,
  MAX_DIMENSIONS, MAX_FILTERS, MAX_ROWS,
  type ReportLevel,
} from './catalog';

export interface ReportFilter {
  field: string;
  operator: string;
  value: string | number | string[];
}

export interface ReportDefinition {
  measures: string[];
  dimensions: string[];
  filters: ReportFilter[];
  from: string;
  to: string;
  sort?: { key: string; direction: 'asc' | 'desc' };
  limit?: number;
}

export interface BuiltQuery {
  /** Consulta de totales: los mismos agregados sin agrupar. */
  totalsSql: string;
  sql: string;
  params: unknown[];
  /** Medidas derivadas a calcular tras agregar. */
  ratios: { id: string; numerator: string; denominator: string }[];
  columns: { id: string; kind: 'dimension' | 'measure'; format?: string }[];
  /** true cuando el importe se repartió entre ítems. */
  allocated: boolean;
}

export class ReportDefinitionError extends Error {
  statusCode = 400;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function fail(message: string): never {
  throw new ReportDefinitionError(message);
}

/** Valida la definición y devuelve el SQL con sus parámetros. */
/** Ventana [inicio, fin) en UTC que corresponde a las fechas locales pedidas. */
export interface ReportWindow {
  windowStart: string;
  windowEnd: string;
  /** Desplazamiento del comercio para agrupar por día/hora en SQL. */
  sqliteOffset: string;
}

export function buildReportQuery(def: ReportDefinition, window: ReportWindow): BuiltQuery {
  const { windowStart, windowEnd, sqliteOffset } = window;
  if (!Array.isArray(def.measures) || def.measures.length === 0) {
    fail('At least one measure is required');
  }
  if (!Array.isArray(def.dimensions)) fail('dimensions must be an array');
  if (def.dimensions.length > MAX_DIMENSIONS) {
    fail(`At most ${MAX_DIMENSIONS} dimensions are allowed`);
  }
  if (!ISO_DATE.test(def.from) || !ISO_DATE.test(def.to)) {
    fail('from and to must use YYYY-MM-DD format');
  }
  if (def.from > def.to) fail('from must not be after to');

  const filters = Array.isArray(def.filters) ? def.filters : [];
  if (filters.length > MAX_FILTERS) fail(`At most ${MAX_FILTERS} filters are allowed`);

  // Resolución contra la lista blanca. Un id ausente termina aquí.
  const dims = def.dimensions.map((id) => DIMENSIONS[id] ?? fail(`Unknown dimension: ${String(id)}`));
  const requested = def.measures.map((id) => MEASURES[id] ?? fail(`Unknown measure: ${String(id)}`));
  const filterDefs = filters.map((f) => {
    const field = FILTER_FIELDS[f?.field] ?? fail(`Unknown filter field: ${String(f?.field)}`);
    const op = OPERATORS[f?.operator] ?? fail(`Unknown operator: ${String(f?.operator)}`);
    if (!op.types.includes(field.type)) {
      fail(`Operator ${f.operator} does not apply to ${f.field}`);
    }
    return { field, op, value: f.value };
  });

  // Las medidas derivadas arrastran sus operandos aunque no se hayan pedido.
  const ratios: BuiltQuery['ratios'] = [];
  const needed = new Set<string>();
  for (const m of requested) {
    if (m.ratioOf) {
      const [num, den] = m.ratioOf;
      if (!MEASURES[num] || !MEASURES[den]) fail(`Invalid ratio measure: ${m.id}`);
      ratios.push({ id: m.id, numerator: num, denominator: den });
      needed.add(num);
      needed.add(den);
    } else {
      needed.add(m.id);
    }
  }

  // Nivel: basta una dimensión, un filtro o una medida de ítem para bajar.
  const level: ReportLevel =
    dims.some((d) => d.level === 'item')
    || filterDefs.some((f) => f.field.level === 'item')
    || [...needed].some((id) => id === 'item_count')
      ? 'item'
      : 'bill';

  const select: string[] = [];
  const groupBy: string[] = [];
  const columns: BuiltQuery['columns'] = [];

  // Las dimensiones de tiempo se calculan sobre la hora local del comercio.
  const localize = (sql: string) => sql.split('b.paid_at').join(`datetime(b.paid_at, '${sqliteOffset}')`);

  dims.forEach((d, i) => {
    const alias = `d${i}`;
    select.push(`${localize(d.sql)} AS ${alias}_key`);
    select.push(`${localize(d.labelSql ?? d.sql)} AS ${alias}_label`);
    groupBy.push(localize(d.sql));
    if (d.labelSql) groupBy.push(localize(d.labelSql));
    columns.push({ id: d.id, kind: 'dimension' });
  });

  for (const id of needed) {
    const m = MEASURES[id];
    const expr = level === 'item' ? (m.itemSql ?? m.billSql) : m.billSql;
    select.push(`${expr} AS m_${id}`);
  }
  for (const m of requested) {
    columns.push({ id: m.id, kind: 'measure', format: m.format });
  }

  const joins = [
    `FROM bills b`,
    `JOIN orders o ON o.id = b.order_id`,
    `LEFT JOIN users u ON u.id = o.user_id`,
    `LEFT JOIN tables t ON t.id = o.table_id`,
    `LEFT JOIN customers c ON c.id = o.customer_id`,
  ];
  if (level === 'item') {
    joins.push(`JOIN order_items oi ON oi.order_id = o.id AND oi.voided_at IS NULL`);
    joins.push(`LEFT JOIN products p ON p.id = oi.product_id`);
    joins.push(`LEFT JOIN categories cat ON cat.id = p.category_id`);
  }

  // Los timestamps se guardan en UTC. Comparar `date(b.paid_at)` metería una
  // venta de las 8 de la noche en Bogotá dentro del día siguiente, así que la
  // ventana se convierte a límites UTC desde la fecha local del comercio,
  // igual que el resto de reportes del proyecto (#208).
  const where: string[] = [
    `b.paid_at IS NOT NULL`,
    `b.paid_at >= ?`,
    `b.paid_at < ?`,
  ];
  const params: unknown[] = [windowStart, windowEnd];

  for (const { field, op, value } of filterDefs) {
    if (op.sql === 'IN') {
      const list = Array.isArray(value) ? value : [value];
      if (list.length === 0) fail(`Filter on ${field.id} needs at least one value`);
      if (list.length > 200) fail(`Filter on ${field.id} has too many values`);
      where.push(`${field.sql} IN (${list.map(() => '?').join(',')})`);
      params.push(...list.map((v) => String(v)));
      continue;
    }
    if (Array.isArray(value)) fail(`Operator ${op.sql} takes a single value`);
    if (field.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) fail(`Filter on ${field.id} needs a number`);
      where.push(`${field.sql} ${op.sql} ?`);
      params.push(n);
    } else {
      where.push(`${field.sql} ${op.sql} ?`);
      params.push(String(value));
    }
  }

  // El orden también sale de la lista blanca, nunca del texto recibido.
  let orderBy = '';
  if (def.sort) {
    const dir = def.sort.direction === 'asc' ? 'ASC' : 'DESC';
    if (MEASURES[def.sort.key] && needed.has(def.sort.key)) {
      orderBy = `ORDER BY m_${def.sort.key} ${dir}`;
    } else {
      const idx = dims.findIndex((d) => d.id === def.sort!.key);
      if (idx >= 0) orderBy = `ORDER BY d${idx}_key ${dir}`;
    }
  }
  if (!orderBy) {
    const firstNonRatio = requested.find((m) => !m.ratioOf);
    if (firstNonRatio) orderBy = `ORDER BY m_${firstNonRatio.id} DESC`;
    else if (dims.length > 0) orderBy = `ORDER BY d0_key ASC`;
  }

  const limit = Math.min(
    Number.isInteger(def.limit) && (def.limit as number) > 0 ? (def.limit as number) : MAX_ROWS,
    MAX_ROWS,
  );

  const sql = [
    `SELECT ${select.join(', ')}`,
    joins.join(' '),
    `WHERE ${where.join(' AND ')}`,
    groupBy.length > 0 ? `GROUP BY ${groupBy.join(', ')}` : '',
    orderBy,
    `LIMIT ${limit}`,
  ].filter(Boolean).join(' ');

  // Mismos agregados, mismos filtros, sin agrupar ni ordenar ni limitar.
  const totalsSelect = [...needed].map((id) => {
    const m = MEASURES[id];
    const expr = level === 'item' ? (m.itemSql ?? m.billSql) : m.billSql;
    return `${expr} AS m_${id}`;
  });
  const totalsSql = [
    `SELECT ${totalsSelect.join(', ')}`,
    joins.join(' '),
    `WHERE ${where.join(' AND ')}`,
  ].join(' ');

  return { sql, totalsSql, params, ratios, columns, allocated: level === 'item' };
}
