/**
 * Cartera y Tesorería: accounts, movements, and payables.
 *
 * Receivables keep their own router (`/api/receivables`) since they were built
 * first and are read straight off the bills; this one covers everything else
 * the screen needs. Both sit behind the same module gate.
 */
import { Router, Request, Response } from 'express';
import { getDatabase, withTxn } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import {
  CarteraError, accountsWithBalances, createEntry, createTransfer, listMovements, voidEntry,
} from '../services/cartera';
import { carteraSummary } from '../services/cartera-summary';
import { createGeneralPayable, listPayables, payPayable, voidGeneralPayable } from '../services/payables';

const router = Router();

function userId(req: Request): string {
  return String((req as any).user?.userId || '');
}

function handleError(res: Response, error: any) {
  if (error instanceof CarteraError) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  console.error('[API] Internal error:', error);
  return res.status(500).json({ error: 'Internal server error' });
}

function cents(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : NaN;
}

// ── Summary and accounts ─────────────────────────────────────────────────────

router.get('/summary', requireRole(...ROLE_ACCESS.ownerManager), (_req: Request, res: Response) => {
  try {
    res.json(carteraSummary(getDatabase()));
  } catch (error: any) {
    handleError(res, error);
  }
});

router.get('/accounts', requireRole(...ROLE_ACCESS.ownerManagerCashier), (_req: Request, res: Response) => {
  try {
    res.json({ accounts: accountsWithBalances(getDatabase()) });
  } catch (error: any) {
    handleError(res, error);
  }
});

router.post('/accounts', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const name = String(req.body?.name || '').trim();
    const kind = String(req.body?.kind || '');
    if (!name) return res.status(400).json({ error: 'Account name is required' });
    if (!['bank', 'digital'].includes(kind)) {
      // The cash account is the drawer itself and is created with the database.
      return res.status(400).json({ error: 'kind must be bank or digital' });
    }
    const openingCents = cents(req.body?.opening_balance_cents) ?? 0;
    if (Number.isNaN(openingCents)) return res.status(400).json({ error: 'opening_balance_cents must be whole cents' });

    const paymentMethodId = req.body?.payment_method_id === undefined || req.body?.payment_method_id === null
      ? null
      : Number(req.body.payment_method_id);
    const canonical = typeof req.body?.canonical_method === 'string' ? req.body.canonical_method : null;
    if (canonical && !['card', 'wallet'].includes(canonical)) {
      return res.status(400).json({ error: 'canonical_method must be card or wallet' });
    }
    if (canonical && paymentMethodId !== null) {
      return res.status(400).json({ error: 'An account binds to one payment method, not two' });
    }
    if (paymentMethodId !== null) {
      const method = db.prepare('SELECT id FROM payment_methods WHERE id = ? AND is_active = 1').get(paymentMethodId);
      if (!method) return res.status(404).json({ error: 'Payment method not found' });
    }

    const openingAsOf = typeof req.body?.opening_as_of === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.opening_as_of)
      ? req.body.opening_as_of
      : new Date().toISOString().slice(0, 10);

    const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM cartera_accounts').get() as { n: number };
    const id = db.prepare(`
      INSERT INTO cartera_accounts
        (name, kind, canonical_method, payment_method_id, opening_balance_cents, opening_as_of, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(name.slice(0, 80), kind, canonical, paymentMethodId, openingCents, openingAsOf, Number(max.n) + 10).lastInsertRowid;

    res.status(201).json({ account: db.prepare('SELECT * FROM cartera_accounts WHERE id = ?').get(id) });
  } catch (error: any) {
    if (String(error?.message || '').includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'An account already uses that name or payment method' });
    }
    handleError(res, error);
  }
});

router.put('/accounts/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const existing = db.prepare('SELECT id FROM cartera_accounts WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Account not found' });
    const name = req.body?.name === undefined ? null : String(req.body.name).trim().slice(0, 80) || null;
    if (req.body?.name !== undefined && !name) return res.status(400).json({ error: 'Account name cannot be empty' });
    db.prepare(`
      UPDATE cartera_accounts SET
        name = COALESCE(@name, name),
        is_active = COALESCE(@is_active, is_active),
        updated_at = @updated_at
      WHERE id = @id
    `).run({
      id: req.params.id,
      name,
      is_active: req.body?.is_active === undefined ? null : (req.body.is_active ? 1 : 0),
      updated_at: new Date().toISOString().replace('T', ' ').replace(/\..*$/, ''),
    });
    res.json({ account: db.prepare('SELECT * FROM cartera_accounts WHERE id = ?').get(req.params.id) });
  } catch (error: any) {
    handleError(res, error);
  }
});

// ── Movements ────────────────────────────────────────────────────────────────

router.get('/movements', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    res.json({ movements: listMovements(getDatabase(), limit) });
  } catch (error: any) {
    handleError(res, error);
  }
});

router.post('/movements', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const kind = req.body?.kind === 'income' ? 'income' : 'expense';
    const amountCents = cents(req.body?.amount_cents);
    if (amountCents === null || Number.isNaN(amountCents)) {
      return res.status(400).json({ error: 'amount_cents must be whole cents' });
    }
    const result = withTxn(() => createEntry(getDatabase(), {
      accountId: Number(req.body?.account_id),
      kind,
      amountCents,
      concept: String(req.body?.concept || ''),
      reference: typeof req.body?.reference === 'string' ? req.body.reference : null,
      userId: userId(req),
    }));
    res.status(201).json(result);
  } catch (error: any) {
    handleError(res, error);
  }
});

router.post('/transfers', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const amountCents = cents(req.body?.amount_cents);
    if (amountCents === null || Number.isNaN(amountCents)) {
      return res.status(400).json({ error: 'amount_cents must be whole cents' });
    }
    const result = withTxn(() => createTransfer(getDatabase(), {
      fromAccountId: Number(req.body?.from_account_id),
      toAccountId: Number(req.body?.to_account_id),
      amountCents,
      concept: typeof req.body?.concept === 'string' ? req.body.concept : null,
      userId: userId(req),
    }));
    res.status(201).json(result);
  } catch (error: any) {
    handleError(res, error);
  }
});

router.post('/movements/:id/void', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    withTxn(() => voidEntry(getDatabase(), Number(req.params.id), String(req.body?.reason || ''), userId(req)));
    res.json({ ok: true });
  } catch (error: any) {
    handleError(res, error);
  }
});

// ── Payables ─────────────────────────────────────────────────────────────────

router.get('/payables', requireRole(...ROLE_ACCESS.ownerManager), (_req: Request, res: Response) => {
  try {
    const { rows, summary } = listPayables(getDatabase());
    res.json({ payables: rows, summary });
  } catch (error: any) {
    handleError(res, error);
  }
});

router.post('/payables', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const totalCents = cents(req.body?.total_cents);
    if (totalCents === null || Number.isNaN(totalCents)) {
      return res.status(400).json({ error: 'total_cents must be whole cents' });
    }
    const result = withTxn(() => createGeneralPayable(getDatabase(), {
      payee_name: String(req.body?.payee_name || ''),
      concept: String(req.body?.concept || ''),
      total_cents: totalCents,
      due_date: String(req.body?.due_date || ''),
      reference: typeof req.body?.reference === 'string' ? req.body.reference : null,
      notes: typeof req.body?.notes === 'string' ? req.body.notes : null,
      userId: userId(req),
    }));
    res.status(201).json(result);
  } catch (error: any) {
    handleError(res, error);
  }
});

router.post('/payables/:source/:id/pay', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const source = req.params.source === 'purchase' ? 'purchase' : 'general';
    const amountCents = cents(req.body?.amount_cents);
    if (Number.isNaN(amountCents)) return res.status(400).json({ error: 'amount_cents must be whole cents' });
    const result = withTxn(() => payPayable(getDatabase(), {
      source,
      id: Number(req.params.id),
      accountId: Number(req.body?.account_id),
      amountCents,
      userId: userId(req),
    }));
    res.json(result);
  } catch (error: any) {
    handleError(res, error);
  }
});

router.post('/payables/general/:id/void', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    withTxn(() => voidGeneralPayable(getDatabase(), Number(req.params.id), String(req.body?.reason || ''), userId(req)));
    res.json({ ok: true });
  } catch (error: any) {
    handleError(res, error);
  }
});

export { router as carteraRoutes };
