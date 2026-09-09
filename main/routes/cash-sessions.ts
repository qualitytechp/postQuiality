/**
 * Apertura y cierre de caja (turnos).
 *
 * Una caja se abre declarando el fondo de cambio y se cierra emitiendo su
 * reporte Z. El fondo deja de declararse al cerrar —cuando ya se conoce el
 * conteo y es tarde para que sirva de control— y pasa a registrarse al abrir,
 * que es cuando el operador realmente lo recibe.
 *
 * Sólo puede haber una caja abierta a la vez (índice parcial
 * `cash_sessions_one_open`), pero varias por fecha: eso habilita turnos y evita
 * que cerrar temprano bloquee el resto del día.
 *
 * Abrir es tarea operativa (dueño, gerente o cajero); cerrar sigue siendo del
 * dueño, porque es el control.
 */
import { Router, Request, Response } from 'express';
import { getDatabase, getSettingValue, localDateInTimezone, now } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';

const router = Router();
const MAX_NOTES_LENGTH = 500;

function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

function tenantTimezone(): string {
  return getSettingValue('timezone') || 'Asia/Kolkata';
}

function validateCents(raw: unknown, field: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw httpError(`${field} must be an integer`, 400);
  }
  if (raw < 0) throw httpError(`${field} must be >= 0`, 400);
  if (!Number.isSafeInteger(raw)) throw httpError(`${field} is out of range`, 400);
  return raw;
}

/** La caja abierta, o null. Compartida con el cierre y con el aviso del POS. */
export function getOpenCashSession(db: ReturnType<typeof getDatabase>): any | null {
  return db.prepare(`
    SELECT s.*, u.name AS opened_by_name
    FROM cash_sessions s
    LEFT JOIN users u ON u.id = s.opened_by
    WHERE s.closed_at IS NULL
    LIMIT 1
  `).get() ?? null;
}

// ── GET /current — la caja abierta, para el aviso y el flujo de cierre ──────
router.get('/current', requireRole(...ROLE_ACCESS.allStaff), (_req: Request, res: Response) => {
  try {
    const session = getOpenCashSession(getDatabase());
    res.json({ session });
  } catch (error: any) {
    console.error('[CashSessions] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET / — historial de cajas de una fecha ────────────────────────────────
router.get('/', requireRole(...ROLE_ACCESS.allStaff), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date
      : localDateInTimezone(new Date(), tenantTimezone());
    const sessions = db.prepare(`
      SELECT s.*, u.name AS opened_by_name, c.z_number
      FROM cash_sessions s
      LEFT JOIN users u ON u.id = s.opened_by
      LEFT JOIN cash_closures c ON c.id = s.closure_id
      WHERE s.business_date = ?
      ORDER BY s.id
    `).all(date);
    res.json({ sessions, businessDate: date });
  } catch (error: any) {
    console.error('[CashSessions] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST / — abrir caja ────────────────────────────────────────────────────
router.post('/', requireRole(...ROLE_ACCESS.ownerManagerCashier), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const body = req.body || {};
    const openedBy = String((req as any).user?.userId || '');
    if (!openedBy) throw httpError('Authentication required', 401);

    if (getOpenCashSession(db)) {
      throw httpError('There is already an open cash session', 409);
    }

    const openingFloatCents = body.opening_float_cents === undefined
      ? 0
      : validateCents(body.opening_float_cents, 'opening_float_cents');
    if (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') {
      throw httpError('notes must be a string', 400);
    }
    if (typeof body.notes === 'string' && body.notes.length > MAX_NOTES_LENGTH) {
      throw httpError('notes is too long', 400);
    }

    const businessDate = localDateInTimezone(new Date(), tenantTimezone());
    const openedAt = now();
    const result = db.prepare(`
      INSERT INTO cash_sessions (business_date, opening_float_cents, opened_by, opened_at, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(businessDate, openingFloatCents, openedBy, openedAt, body.notes || null);

    const session = db.prepare(`
      SELECT s.*, u.name AS opened_by_name
      FROM cash_sessions s LEFT JOIN users u ON u.id = s.opened_by
      WHERE s.id = ?
    `).get(result.lastInsertRowid);
    res.status(201).json({ session });
  } catch (error: any) {
    const status = error.statusCode || 500;
    if (status === 500) console.error('[CashSessions] Internal error:', error);
    res.status(status).json({ error: status === 500 ? 'Internal server error' : error.message });
  }
});

export { router as cashSessionRoutes };
