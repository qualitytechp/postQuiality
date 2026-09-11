/**
 * Payables: what the business owes.
 *
 * Two sources, one list. A credit purchase already is a payable — the purchase
 * is the debt, and its balance is total less what has been paid, exactly like
 * a bill is a receivable. A general payable covers what never passes through
 * purchasing at all: rent, payroll, the power bill.
 *
 * Neither stores a balance. Both are paid in instalments through the same
 * shape, so an abono is the ordinary case rather than a special one.
 */
import type Database from 'better-sqlite3';
import { now } from '../db';
import {
  CarteraError, assertCashCovers, businessToday, getAccount, openCashSession,
} from './cartera';

export type PayableSource = 'purchase' | 'general';
export type AgeBucket = 'current' | 'week' | 'month' | 'overdue';

export interface PayableRow {
  source: PayableSource;
  id: number;
  number: string;
  payee: string;
  reference: string | null;
  concept: string;
  total_cents: number;
  paid_cents: number;
  balance_cents: number;
  due_date: string;
  age_bucket: AgeBucket;
  days_overdue: number;
}

function daysBetween(fromDate: string, toDate: string): number {
  const [fy, fm, fd] = fromDate.split('-').map(Number);
  const [ty, tm, td] = toDate.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

export function bucketFor(daysOverdue: number): AgeBucket {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 7) return 'week';
  if (daysOverdue <= 30) return 'month';
  return 'overdue';
}

export function listPayables(db: Database.Database): {
  rows: PayableRow[];
  summary: { total_balance_cents: number; overdue_balance_cents: number; payee_count: number };
} {
  const today = businessToday();

  const purchases = db.prepare(`
    SELECT p.id, p.purchase_number, p.invoice_ref, p.due_date, p.total_cents, s.name AS supplier_name,
           COALESCE((SELECT SUM(amount_cents) FROM purchase_payments WHERE purchase_id = p.id), 0) AS paid_cents
    FROM purchases p
    JOIN suppliers s ON s.id = p.supplier_id
    WHERE p.status = 'received' AND p.payment_terms = 'credit'
  `).all() as any[];

  const generals = db.prepare(`
    SELECT gp.*,
           COALESCE((SELECT SUM(amount_cents) FROM general_payable_payments WHERE payable_id = gp.id), 0) AS paid_cents
    FROM general_payables gp
    WHERE gp.status = 'open'
  `).all() as any[];

  const rows: PayableRow[] = [];

  for (const row of purchases) {
    const balance = Number(row.total_cents) - Number(row.paid_cents);
    if (balance <= 0) continue;
    const daysOverdue = Math.max(0, daysBetween(row.due_date, today));
    rows.push({
      source: 'purchase', id: row.id, number: row.purchase_number, payee: row.supplier_name,
      reference: row.invoice_ref, concept: row.purchase_number,
      total_cents: Number(row.total_cents), paid_cents: Number(row.paid_cents), balance_cents: balance,
      due_date: row.due_date, age_bucket: bucketFor(daysOverdue), days_overdue: daysOverdue,
    });
  }

  for (const row of generals) {
    const balance = Number(row.total_cents) - Number(row.paid_cents);
    if (balance <= 0) continue;
    const daysOverdue = Math.max(0, daysBetween(row.due_date, today));
    rows.push({
      source: 'general', id: row.id, number: row.payable_number, payee: row.payee_name,
      reference: row.reference, concept: row.concept,
      total_cents: Number(row.total_cents), paid_cents: Number(row.paid_cents), balance_cents: balance,
      due_date: row.due_date, age_bucket: bucketFor(daysOverdue), days_overdue: daysOverdue,
    });
  }

  rows.sort((a, b) => b.days_overdue - a.days_overdue || a.due_date.localeCompare(b.due_date));

  return {
    rows,
    summary: {
      total_balance_cents: rows.reduce((sum, row) => sum + row.balance_cents, 0),
      overdue_balance_cents: rows.filter((r) => r.age_bucket !== 'current').reduce((sum, r) => sum + r.balance_cents, 0),
      payee_count: new Set(rows.map((r) => `${r.source}:${r.payee}`)).size,
    },
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function createGeneralPayable(db: Database.Database, input: {
  payee_name: string; concept: string; total_cents: number; due_date: string;
  reference?: string | null; notes?: string | null; userId: string;
}): { id: number; payable_number: string } {
  const payee = String(input.payee_name || '').trim();
  const concept = String(input.concept || '').trim();
  if (!payee) throw new CarteraError('A payable needs someone to pay');
  if (!concept) throw new CarteraError('A payable needs a concept');
  if (!Number.isInteger(input.total_cents) || input.total_cents <= 0) {
    throw new CarteraError('Amount must be a whole number of cents, greater than zero');
  }
  if (!ISO_DATE.test(input.due_date)) throw new CarteraError('due_date must be YYYY-MM-DD');

  const date = businessToday();
  const sequence = db.prepare(
    `SELECT COUNT(*) AS n FROM general_payables WHERE business_date = ?`,
  ).get(date) as { n: number };
  const payableNumber = `GAS-${date.replace(/-/g, '')}-${String(Number(sequence.n) + 1).padStart(4, '0')}`;

  const id = db.prepare(`
    INSERT INTO general_payables
      (payable_number, payee_name, reference, concept, total_cents, due_date, status, notes, business_date, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
  `).run(
    payableNumber, payee.slice(0, 120), input.reference?.trim().slice(0, 100) || null,
    concept.slice(0, 200), input.total_cents, input.due_date,
    input.notes?.trim().slice(0, 500) || null, date, input.userId, now(),
  ).lastInsertRowid;

  return { id: Number(id), payable_number: payableNumber };
}

/** Records an instalment against either kind of payable. */
export function payPayable(db: Database.Database, input: {
  source: PayableSource; id: number; accountId: number;
  amountCents?: number | null; userId: string;
}): { paid_cents: number; balance_cents: number } {
  const account = getAccount(db, input.accountId);
  if (!account) throw new CarteraError('Account not found', 404);
  if (!account.is_active) throw new CarteraError('Account is inactive');

  let totalCents: number;
  let paidCents: number;
  if (input.source === 'purchase') {
    const purchase = db.prepare(`SELECT id, total_cents, status, payment_terms FROM purchases WHERE id = ?`)
      .get(input.id) as { id: number; total_cents: number; status: string; payment_terms: string } | undefined;
    if (!purchase) throw new CarteraError('Purchase not found', 404);
    if (purchase.status === 'void') throw new CarteraError('Purchase is void', 409);
    totalCents = Number(purchase.total_cents);
    paidCents = Number((db.prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS n FROM purchase_payments WHERE purchase_id = ?`,
    ).get(input.id) as { n: number }).n);
  } else {
    const payable = db.prepare(`SELECT id, total_cents, status FROM general_payables WHERE id = ?`)
      .get(input.id) as { id: number; total_cents: number; status: string } | undefined;
    if (!payable) throw new CarteraError('Payable not found', 404);
    if (payable.status === 'void') throw new CarteraError('Payable is void', 409);
    totalCents = Number(payable.total_cents);
    paidCents = Number((db.prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS n FROM general_payable_payments WHERE payable_id = ?`,
    ).get(input.id) as { n: number }).n);
  }

  const remaining = totalCents - paidCents;
  if (remaining <= 0) throw new CarteraError('This is already paid in full', 409);

  // No amount means settle the rest, which is what a merchant means by
  // tapping Pay on a balance without typing anything.
  const amount = input.amountCents === undefined || input.amountCents === null
    ? remaining
    : input.amountCents;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new CarteraError('Amount must be a whole number of cents, greater than zero');
  }
  if (amount > remaining) throw new CarteraError('Payment is larger than the outstanding balance');

  let sessionId: number | null = null;
  if (account.kind === 'cash') {
    const session = openCashSession(db);
    if (!session) throw new CarteraError('Open the register before paying with cash', 409);
    assertCashCovers(db, account, amount);
    sessionId = session.id;
  }

  const timestamp = now();
  const date = businessToday();
  if (input.source === 'purchase') {
    db.prepare(`
      INSERT INTO purchase_payments
        (purchase_id, amount_cents, method, paid_at, business_date, cash_session_id, account_id, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, amount, account.canonical_method || account.name, timestamp, date, sessionId, account.id, input.userId, timestamp);
  } else {
    db.prepare(`
      INSERT INTO general_payable_payments
        (payable_id, account_id, amount_cents, paid_at, business_date, cash_session_id, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, account.id, amount, timestamp, date, sessionId, input.userId, timestamp);
  }

  return { paid_cents: paidCents + amount, balance_cents: remaining - amount };
}

export function voidGeneralPayable(db: Database.Database, id: number, reason: string, userId: string): void {
  const payable = db.prepare('SELECT id, status FROM general_payables WHERE id = ?').get(id) as
    { id: number; status: string } | undefined;
  if (!payable) throw new CarteraError('Payable not found', 404);
  if (payable.status === 'void') throw new CarteraError('Payable is already void', 409);
  if (!reason || !String(reason).trim()) throw new CarteraError('Voiding a payable needs a reason');
  const paid = Number((db.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS n FROM general_payable_payments WHERE payable_id = ?`,
  ).get(id) as { n: number }).n);
  if (paid > 0) throw new CarteraError('This payable has payments against it; void those first', 409);

  db.prepare(`UPDATE general_payables SET status = 'void', voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?`)
    .run(now(), userId, String(reason).trim().slice(0, 300), id);
}
