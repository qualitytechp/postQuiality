/**
 * Suppliers and purchases.
 *
 * Both routers sit behind the `purchases` module gate, mounted in routes/index.
 * Credit terms are refused unless the `receivables` module is also on: with no
 * receivables surface there is nowhere for the debt to be seen or settled, so
 * accepting it would create a balance the merchant cannot reach. That is the
 * composition rule — neither module requires the other, and the surface that
 * joins them only exists while both are on.
 */
import { Router, Request, Response } from 'express';
import { getDatabase, generateShortId, now, withTxn } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import { isModuleEnabled } from '../services/modules';
import { createPurchase, voidPurchase, PurchaseError } from '../services/purchases';

const supplierRouter = Router();
const purchaseRouter = Router();

const MAX_NAME = 120;
const MAX_TEXT = 500;

function userId(req: Request): string {
  return String((req as any).user?.userId || '');
}

function handleError(res: Response, error: any) {
  if (error instanceof PurchaseError) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  console.error('[API] Internal error:', error);
  return res.status(500).json({ error: 'Internal server error' });
}

function trimmed(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

// ── Suppliers ────────────────────────────────────────────────────────────────

supplierRouter.get('/', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const includeInactive = req.query.include_inactive === 'true';
    const rows = getDatabase().prepare(`
      SELECT * FROM suppliers ${includeInactive ? '' : 'WHERE is_active = 1'}
      ORDER BY name COLLATE NOCASE
    `).all();
    res.json({ suppliers: rows });
  } catch (error: any) {
    handleError(res, error);
  }
});

supplierRouter.post('/', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const name = trimmed(req.body?.name, MAX_NAME);
    if (!name) return res.status(400).json({ error: 'Supplier name is required' });

    const id = generateShortId('suppliers');
    const stamp = now();
    getDatabase().prepare(`
      INSERT INTO suppliers (id, name, document, phone, address, notes, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id, name,
      trimmed(req.body?.document, MAX_NAME), trimmed(req.body?.phone, MAX_NAME),
      trimmed(req.body?.address, MAX_TEXT), trimmed(req.body?.notes, MAX_TEXT),
      stamp, stamp,
    );
    res.status(201).json({ supplier: getDatabase().prepare('SELECT * FROM suppliers WHERE id = ?').get(id) });
  } catch (error: any) {
    handleError(res, error);
  }
});

supplierRouter.put('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const existing = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Supplier not found' });

    const name = req.body?.name === undefined ? null : trimmed(req.body.name, MAX_NAME);
    if (req.body?.name !== undefined && !name) {
      return res.status(400).json({ error: 'Supplier name cannot be empty' });
    }
    db.prepare(`
      UPDATE suppliers SET
        name      = COALESCE(@name, name),
        document  = COALESCE(@document, document),
        phone     = COALESCE(@phone, phone),
        address   = COALESCE(@address, address),
        notes     = COALESCE(@notes, notes),
        is_active = COALESCE(@is_active, is_active),
        updated_at = @updated_at
      WHERE id = @id
    `).run({
      id: req.params.id,
      name,
      document: req.body?.document === undefined ? null : trimmed(req.body.document, MAX_NAME),
      phone: req.body?.phone === undefined ? null : trimmed(req.body.phone, MAX_NAME),
      address: req.body?.address === undefined ? null : trimmed(req.body.address, MAX_TEXT),
      notes: req.body?.notes === undefined ? null : trimmed(req.body.notes, MAX_TEXT),
      is_active: req.body?.is_active === undefined ? null : (req.body.is_active ? 1 : 0),
      updated_at: now(),
    });
    res.json({ supplier: db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id) });
  } catch (error: any) {
    handleError(res, error);
  }
});

// ── Purchases ────────────────────────────────────────────────────────────────

purchaseRouter.get('/', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const rows = getDatabase().prepare(`
      SELECT p.*, s.name AS supplier_name,
             COALESCE((SELECT SUM(amount_cents) FROM purchase_payments WHERE purchase_id = p.id), 0) AS paid_cents,
             p.total_cents - COALESCE((SELECT SUM(amount_cents) FROM purchase_payments WHERE purchase_id = p.id), 0) AS balance_cents
      FROM purchases p
      JOIN suppliers s ON s.id = p.supplier_id
      ORDER BY p.id DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
    const total = (getDatabase().prepare('SELECT COUNT(*) AS count FROM purchases').get() as any).count;
    res.json({ purchases: rows, total, limit, offset });
  } catch (error: any) {
    handleError(res, error);
  }
});

purchaseRouter.get('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const purchase = db.prepare(`
      SELECT p.*, s.name AS supplier_name,
             COALESCE((SELECT SUM(amount_cents) FROM purchase_payments WHERE purchase_id = p.id), 0) AS paid_cents,
             p.total_cents - COALESCE((SELECT SUM(amount_cents) FROM purchase_payments WHERE purchase_id = p.id), 0) AS balance_cents
      FROM purchases p JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.id = ?
    `).get(req.params.id);
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });

    res.json({
      purchase,
      items: db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY id').all(req.params.id),
      payments: db.prepare('SELECT * FROM purchase_payments WHERE purchase_id = ? ORDER BY id').all(req.params.id),
    });
  } catch (error: any) {
    handleError(res, error);
  }
});

purchaseRouter.post('/', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const terms = req.body?.payment_terms === 'credit' ? 'credit' : 'cash';
    if (terms === 'credit' && !isModuleEnabled('receivables')) {
      return res.status(400).json({
        error: 'Credit purchases need the receivables module turned on',
        module: 'receivables',
        enabled: false,
      });
    }

    const created = withTxn(() => createPurchase(getDatabase(), {
      supplier_id: String(req.body?.supplier_id || ''),
      invoice_ref: trimmed(req.body?.invoice_ref, MAX_NAME),
      notes: trimmed(req.body?.notes, MAX_TEXT),
      payment_terms: terms,
      due_date: typeof req.body?.due_date === 'string' ? req.body.due_date : null,
      tax_cents: Number(req.body?.tax_cents) || 0,
      items: Array.isArray(req.body?.items) ? req.body.items : [],
      payment_method: trimmed(req.body?.payment_method, MAX_NAME),
      userId: userId(req),
    }));
    res.status(201).json(created);
  } catch (error: any) {
    handleError(res, error);
  }
});

purchaseRouter.post('/:id/void', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const result = withTxn(() => voidPurchase(
      getDatabase(), Number(req.params.id), String(req.body?.reason || ''), userId(req),
    ));
    res.json(result);
  } catch (error: any) {
    handleError(res, error);
  }
});

export { supplierRouter as supplierRoutes, purchaseRouter as purchaseRoutes };
