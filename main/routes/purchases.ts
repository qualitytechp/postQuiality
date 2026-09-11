/**
 * Suppliers and purchases.
 *
 * Both routers sit behind the `purchases` module gate, mounted in routes/index.
 *
 * A purchase carries its own balance and takes instalments here, because
 * paying the supplier later is how buying ordinarily works — not a feature of
 * another module. Cartera, when it is on, aggregates these balances into its
 * "to pay" view alongside the expenses that never pass through purchasing.
 */
import { Router, Request, Response } from 'express';
import { getDatabase, generateShortId, now, withTxn } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import { isModuleEnabled } from '../services/modules';
import { createPurchase, payPurchase, updatePurchase, voidPurchase, PurchaseError } from '../services/purchases';
import { businessToday } from '../services/cartera';

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
    const db = getDatabase();
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    // The list carries its own lines and payments: the screen shows them as
    // soon as a row is opened, and a second round-trip per row would make
    // scanning a month of purchases feel slow for no reason.
    const rows = db.prepare(`
      SELECT p.*, s.name AS supplier_name,
             COALESCE(paid.amount, 0) AS paid_cents,
             p.total_cents - COALESCE(paid.amount, 0) AS balance_cents,
             COALESCE(items.line_count, 0) AS item_count,
             COALESCE(items.unit_count, 0) AS unit_count,
             paid.methods AS payment_methods
      FROM purchases p
      JOIN suppliers s ON s.id = p.supplier_id
      LEFT JOIN (
        SELECT purchase_id, SUM(amount_cents) AS amount, GROUP_CONCAT(DISTINCT method) AS methods
        FROM purchase_payments GROUP BY purchase_id
      ) paid ON paid.purchase_id = p.id
      LEFT JOIN (
        SELECT purchase_id, COUNT(*) AS line_count, SUM(quantity) AS unit_count
        FROM purchase_items GROUP BY purchase_id
      ) items ON items.purchase_id = p.id
      ORDER BY p.id DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as any[];

    const ids = rows.map((row) => row.id);
    const itemsByPurchase = new Map<number, any[]>();
    const paymentsByPurchase = new Map<number, any[]>();
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      for (const item of db.prepare(
        `SELECT * FROM purchase_items WHERE purchase_id IN (${placeholders}) ORDER BY id`,
      ).all(...ids) as any[]) {
        if (!itemsByPurchase.has(item.purchase_id)) itemsByPurchase.set(item.purchase_id, []);
        itemsByPurchase.get(item.purchase_id)!.push(item);
      }
      for (const payment of db.prepare(
        `SELECT * FROM purchase_payments WHERE purchase_id IN (${placeholders}) ORDER BY id`,
      ).all(...ids) as any[]) {
        if (!paymentsByPurchase.has(payment.purchase_id)) paymentsByPurchase.set(payment.purchase_id, []);
        paymentsByPurchase.get(payment.purchase_id)!.push(payment);
      }
    }

    const purchases = rows.map((row) => ({
      ...row,
      // 'paid' the moment nothing is owed, 'partial' once something has been
      // handed over, 'pending' while untouched. Derived, never stored: a
      // status column would be one more thing that can disagree with the sums.
      settlement: row.status === 'void' ? 'void'
        : row.balance_cents <= 0 ? 'paid'
          : row.paid_cents > 0 ? 'partial' : 'pending',
      items: itemsByPurchase.get(row.id) || [],
      payments: paymentsByPurchase.get(row.id) || [],
    }));

    const total = (db.prepare('SELECT COUNT(*) AS count FROM purchases').get() as any).count;
    res.json({ purchases, total, limit, offset, stats: monthStats(db) });
  } catch (error: any) {
    handleError(res, error);
  }
});

/** Headline figures for the current business month. */
function monthStats(db: ReturnType<typeof getDatabase>) {
  const month = businessToday().slice(0, 7);
  const row = db.prepare(`
    SELECT COUNT(*) AS purchase_count,
           COALESCE(SUM(p.total_cents), 0) AS spent_cents,
           COALESCE(SUM((SELECT SUM(quantity) FROM purchase_items WHERE purchase_id = p.id)), 0) AS unit_count
    FROM purchases p
    WHERE p.status = 'received' AND substr(p.business_date, 1, 7) = ?
  `).get(month) as { purchase_count: number; spent_cents: number; unit_count: number };

  const outstanding = db.prepare(`
    SELECT COUNT(*) AS purchase_count, COALESCE(SUM(balance), 0) AS balance_cents FROM (
      SELECT p.total_cents - COALESCE((
        SELECT SUM(amount_cents) FROM purchase_payments WHERE purchase_id = p.id
      ), 0) AS balance
      FROM purchases p WHERE p.status = 'received'
    ) WHERE balance > 0
  `).get() as { purchase_count: number; balance_cents: number };

  return {
    month,
    purchase_count: Number(row.purchase_count || 0),
    unit_count: Number(row.unit_count || 0),
    spent_cents: Number(row.spent_cents || 0),
    outstanding_count: Number(outstanding.purchase_count || 0),
    outstanding_cents: Number(outstanding.balance_cents || 0),
  };
}

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
      amendments: db.prepare('SELECT * FROM purchase_amendments WHERE purchase_id = ? ORDER BY id').all(req.params.id),
      payments: db.prepare('SELECT * FROM purchase_payments WHERE purchase_id = ? ORDER BY id').all(req.params.id),
    });
  } catch (error: any) {
    handleError(res, error);
  }
});

purchaseRouter.post('/', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    // Paying the supplier later is ordinary buying, not a Cartera feature:
    // the purchase tracks its own balance either way. Cartera, when on, adds
    // the aggregated view across every payable.
    const terms = req.body?.payment_terms === 'credit' ? 'credit' : 'cash';

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

/**
 * Corrects a purchase. Metadata can always be fixed; changing the lines also
 * corrects the stock, through the ledger, so the books show the correction
 * rather than a number that quietly changed.
 */
purchaseRouter.put('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const result = withTxn(() => updatePurchase(getDatabase(), Number(req.params.id), {
      supplier_id: req.body?.supplier_id === undefined ? undefined : String(req.body.supplier_id),
      invoice_ref: req.body?.invoice_ref === undefined ? undefined : trimmed(req.body.invoice_ref, MAX_NAME),
      notes: req.body?.notes === undefined ? undefined : trimmed(req.body.notes, MAX_TEXT),
      payment_terms: req.body?.payment_terms === 'credit' ? 'credit'
        : req.body?.payment_terms === 'cash' ? 'cash' : undefined,
      due_date: req.body?.due_date === undefined ? undefined
        : (typeof req.body.due_date === 'string' ? req.body.due_date : null),
      tax_cents: req.body?.tax_cents === undefined ? undefined : Number(req.body.tax_cents),
      items: Array.isArray(req.body?.items) ? req.body.items : undefined,
      reason: typeof req.body?.reason === 'string' ? req.body.reason : null,
      userId: userId(req),
    }));
    res.json(result);
  } catch (error: any) {
    handleError(res, error);
  }
});

/**
 * An instalment against a purchase. Paying the supplier later is how buying
 * ordinarily works, so this lives in Purchases rather than behind Cartera —
 * Cartera only aggregates these into its "to pay" view when it is turned on.
 */
purchaseRouter.post('/:id/payments', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const amountCents = req.body?.amount_cents === undefined || req.body?.amount_cents === null
      ? null
      : Number(req.body.amount_cents);
    if (amountCents !== null && !Number.isInteger(amountCents)) {
      return res.status(400).json({ error: 'amount_cents must be whole cents' });
    }
    const result = withTxn(() => payPurchase(getDatabase(), {
      purchaseId: Number(req.params.id),
      amountCents,
      method: typeof req.body?.method === 'string' ? req.body.method : null,
      accountId: req.body?.account_id === undefined || req.body?.account_id === null
        ? null
        : Number(req.body.account_id),
      userId: userId(req),
    }));
    res.json(result);
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
