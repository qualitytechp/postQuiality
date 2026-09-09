/**
 * Generador de reportes personalizados. Exclusivo del propietario.
 *
 * `POST /api/reports/query` recibe una definición (medidas, dimensiones,
 * filtros, periodo) y devuelve las filas agregadas. Es POST y no GET porque la
 * definición es un objeto anidado, no una cadena de consulta.
 *
 * Toda la seguridad vive en `reports/catalog.ts`: el cliente sólo manda
 * identificadores y el servidor los traduce a expresiones escritas en el
 * repositorio. Un identificador desconocido es un 400, nunca SQL.
 */
import { Router, Request, Response } from 'express';
import { dayBoundsInTimezone, getDatabase, getSettingValue, now } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import { randomUUID } from 'crypto';
import { DIMENSIONS, MEASURES, FILTER_FIELDS, OPERATORS, MAX_DIMENSIONS } from '../reports/catalog';
import { buildReportQuery, ReportDefinitionError, type ReportDefinition, type ReportWindow } from '../reports/query-builder';

const router = Router();
const MAX_NAME_LENGTH = 80;

function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

/** Lo que la interfaz necesita para pintar los selectores. */
router.get('/catalog', requireRole(...ROLE_ACCESS.owner), (_req: Request, res: Response) => {
  try {
    res.json({
      dimensions: Object.values(DIMENSIONS).map((d) => ({ id: d.id, level: d.level })),
      measures: Object.values(MEASURES).map((m) => ({ id: m.id, format: m.format })),
      filterFields: Object.values(FILTER_FIELDS).map((f) => ({ id: f.id, type: f.type, level: f.level })),
      operators: Object.entries(OPERATORS).map(([id, o]) => ({ id, types: o.types })),
      limits: { maxDimensions: MAX_DIMENSIONS },
    });
  } catch (error: any) {
    console.error('[ReportQuery] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Ventana UTC y desplazamiento del comercio para una definición. */
function resolveWindow(def: ReportDefinition): ReportWindow {
  const timezone = getSettingValue('timezone') || 'Asia/Kolkata';
  if (!ISO_DATE.test(def?.from ?? '') || !ISO_DATE.test(def?.to ?? '')) {
    throw new ReportDefinitionError('from and to must use YYYY-MM-DD format');
  }
  const windowStart = dayBoundsInTimezone(def.from, timezone)[0];
  const windowEnd = dayBoundsInTimezone(def.to, timezone)[1];
  // SQLite no trae base de datos de zonas horarias: se le pasa el
  // desplazamiento vigente al inicio de la ventana. Exacto en zonas sin
  // horario de verano (Colombia, India); en zonas con DST una ventana que
  // cruce el cambio agrupa esa hora en el día contiguo.
  const reference = new Date(`${windowStart.replace(' ', 'T')}Z`);
  const local = new Date(reference.toLocaleString('en-US', { timeZone: timezone }));
  const utc = new Date(reference.toLocaleString('en-US', { timeZone: 'UTC' }));
  const minutes = Math.round((local.getTime() - utc.getTime()) / 60000);
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const sqliteOffset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return { windowStart, windowEnd, sqliteOffset };
}

function runQuery(def: ReportDefinition) {
  const built = buildReportQuery(def, resolveWindow(def));
  const db = getDatabase();
  const raw = db.prepare(built.sql).all(...(built.params as any[])) as any[];

  const dimensionIds = built.columns.filter((c) => c.kind === 'dimension').map((c) => c.id);
  const measureIds = built.columns.filter((c) => c.kind === 'measure').map((c) => c.id);

  const rows = raw.map((r) => {
    const dims: Record<string, { key: string; label: string }> = {};
    dimensionIds.forEach((id, i) => {
      dims[id] = { key: String(r[`d${i}_key`] ?? ''), label: String(r[`d${i}_label`] ?? '') };
    });
    const values: Record<string, number> = {};
    for (const id of measureIds) {
      const ratio = built.ratios.find((x) => x.id === id);
      if (ratio) {
        const den = Number(r[`m_${ratio.denominator}`] || 0);
        values[id] = den === 0 ? 0 : Number(r[`m_${ratio.numerator}`] || 0) / den;
      } else {
        values[id] = Number(r[`m_${id}`] || 0);
      }
    }
    return { dimensions: dims, values };
  });

  // Los totales se calculan sin agrupar. Sumar las filas mostradas contaría
  // dos veces una factura que toca dos categorías, y recortar por LIMIT
  // daría un total que no cuadra con el periodo.
  const totalRow = (db.prepare(built.totalsSql).get(...(built.params as any[])) ?? {}) as any;
  const totals: Record<string, number> = {};
  for (const id of measureIds) {
    const ratio = built.ratios.find((x) => x.id === id);
    if (ratio) {
      const den = Number(totalRow[`m_${ratio.denominator}`] || 0);
      totals[id] = den === 0 ? 0 : Number(totalRow[`m_${ratio.numerator}`] || 0) / den;
    } else {
      totals[id] = Number(totalRow[`m_${id}`] || 0);
    }
  }

  return { rows, totals, columns: built.columns, allocated: built.allocated };
}

router.post('/query', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const result = runQuery((req.body || {}) as ReportDefinition);
    res.json(result);
  } catch (error: any) {
    if (error instanceof ReportDefinitionError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('[ReportQuery] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Una celda CSV segura: comillas dobladas y prefijo ante caracteres de fórmula. */
function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}

router.post('/query.csv', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const { rows, totals, columns } = runQuery((req.body || {}) as ReportDefinition);
    const header = columns.map((c) => csvCell(c.id)).join(',');
    const body = rows.map((row) => columns.map((c) => (
      c.kind === 'dimension'
        ? csvCell(row.dimensions[c.id]?.label ?? '')
        : csvCell(row.values[c.id] ?? 0)
    )).join(','));
    const totalRow = columns.map((c, i) => (
      c.kind === 'dimension' ? csvCell(i === 0 ? 'TOTAL' : '') : csvCell(totals[c.id] ?? 0)
    )).join(',');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="reporte.csv"');
    // BOM para que Excel reconozca UTF-8 y no destroce los acentos.
    res.send('﻿' + [header, ...body, totalRow].join('\r\n'));
  } catch (error: any) {
    if (error instanceof ReportDefinitionError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('[ReportQuery] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Reportes guardados ─────────────────────────────────────────────────────

router.get('/saved', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const userId = String((req as any).user?.userId || '');
    const rows = getDatabase().prepare(
      `SELECT id, name, definition_json, created_at, updated_at
       FROM saved_reports WHERE user_id = ? ORDER BY name`
    ).all(userId) as any[];
    res.json({
      reports: rows.map((r) => ({
        id: r.id,
        name: r.name,
        definition: JSON.parse(r.definition_json),
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
    });
  } catch (error: any) {
    console.error('[ReportQuery] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/saved', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const userId = String((req as any).user?.userId || '');
    if (!userId) throw httpError('Authentication required', 401);
    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) throw httpError('name is required', 400);
    if (name.length > MAX_NAME_LENGTH) throw httpError('name is too long', 400);

    // Se valida antes de guardar: una definición inválida nunca llega a la tabla.
    buildReportQuery(body.definition as ReportDefinition, resolveWindow(body.definition as ReportDefinition));

    const db = getDatabase();
    const existing = db.prepare('SELECT id FROM saved_reports WHERE user_id = ? AND name = ?')
      .get(userId, name) as { id: string } | undefined;
    const stamp = now();
    const id = existing?.id ?? randomUUID();
    if (existing) {
      db.prepare('UPDATE saved_reports SET definition_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(body.definition), stamp, id);
    } else {
      db.prepare(`INSERT INTO saved_reports (id, user_id, name, definition_json, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, userId, name, JSON.stringify(body.definition), stamp, stamp);
    }
    res.status(existing ? 200 : 201).json({ report: { id, name, definition: body.definition } });
  } catch (error: any) {
    if (error instanceof ReportDefinitionError) {
      return res.status(400).json({ error: error.message });
    }
    const status = error.statusCode || 500;
    if (status === 500) console.error('[ReportQuery] Internal error:', error);
    res.status(status).json({ error: status === 500 ? 'Internal server error' : error.message });
  }
});

router.delete('/saved/:id', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const userId = String((req as any).user?.userId || '');
    // El filtro por dueño es también la autorización: nadie borra lo ajeno.
    const result = getDatabase().prepare('DELETE FROM saved_reports WHERE id = ? AND user_id = ?')
      .run(req.params.id, userId);
    if (result.changes === 0) return res.status(404).json({ error: 'Report not found' });
    res.json({ success: true });
  } catch (error: any) {
    console.error('[ReportQuery] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as reportQueryRoutes };
