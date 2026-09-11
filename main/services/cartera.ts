/**
 * Treasury: where the money is and how it moves.
 *
 * Two rules hold this together:
 *
 *   · Nothing stores a balance. An account's balance is derived from its
 *     opening figure plus everything that has happened since — POS collections
 *     via its payment method, refunds, what has been paid out of it, and its
 *     own manual entries. A stored balance is a balance that eventually
 *     disagrees with the movements that produced it.
 *
 *   · The cash account is the exception, and deliberately so. Physical cash
 *     already has an owner in this codebase: the open/close cycle in
 *     `cash_sessions` and `cash_closures`. Cartera mirrors that number rather
 *     than keeping a second one, so the drawer can never have two truths.
 */
import type Database from 'better-sqlite3';
import { getSettingValue, localDateInTimezone, now, parseDbTimestamp } from '../db';
import { getCurrencyMinorUnitFactor } from '../countries';

export type AccountKind = 'cash' | 'bank' | 'digital';
export type EntryKind = 'income' | 'expense' | 'transfer';

export interface CarteraAccount {
  id: number;
  name: string;
  kind: AccountKind;
  canonical_method: string | null;
  payment_method_id: number | null;
  opening_balance_cents: number;
  opening_as_of: string;
  is_active: number;
  sort_order: number;
}

export interface AccountWithBalance extends CarteraAccount {
  balance_cents: number;
  inflow_cents: number;
  outflow_cents: number;
}

export class CarteraError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function tenantTimezone(): string {
  return getSettingValue('timezone') || 'Asia/Kolkata';
}

export function businessToday(): string {
  return localDateInTimezone(new Date(), tenantTimezone());
}

export function minorFactor(): number {
  return getCurrencyMinorUnitFactor(getSettingValue('currency') || 'INR');
}

export function listAccounts(db: Database.Database, includeInactive = false): CarteraAccount[] {
  return db.prepare(`
    SELECT * FROM cartera_accounts
    ${includeInactive ? '' : 'WHERE is_active = 1'}
    ORDER BY sort_order, id
  `).all() as CarteraAccount[];
}

export function getAccount(db: Database.Database, id: number): CarteraAccount | undefined {
  return db.prepare('SELECT * FROM cartera_accounts WHERE id = ?').get(id) as CarteraAccount | undefined;
}

export function cashAccount(db: Database.Database): CarteraAccount | undefined {
  return db.prepare(`SELECT * FROM cartera_accounts WHERE kind = 'cash'`).get() as CarteraAccount | undefined;
}

/** The open cash session, if the drawer is open right now. */
export function openCashSession(db: Database.Database): { id: number; opening_float_cents: number; opened_at: string; business_date: string } | undefined {
  return db.prepare(`
    SELECT id, opening_float_cents, opened_at, business_date
    FROM cash_sessions WHERE closed_at IS NULL
  `).get() as any;
}

/**
 * What a POS payment line has to look like to count toward this account.
 * Canonical methods ('cash', 'card', 'wallet') match by name; a merchant's own
 * method matches by its id, which is how the bill stores it.
 */
function accountMatchClause(account: CarteraAccount): { clause: string; params: unknown[] } | null {
  if (account.canonical_method) {
    return {
      clause: `COALESCE(NULLIF(json_extract(je.value, '$.method'), ''), '') = ?`,
      params: [account.canonical_method],
    };
  }
  if (account.payment_method_id !== null) {
    return {
      clause: `CAST(json_extract(je.value, '$.payment_method_id') AS INTEGER) = ?`,
      params: [account.payment_method_id],
    };
  }
  return null;
}

/** Collections that landed in this account, from the bills themselves. */
function collectionsCents(db: Database.Database, account: CarteraAccount, sinceDate: string): number {
  const match = accountMatchClause(account);
  if (!match) return 0;
  const row = db.prepare(`
    SELECT COALESCE(SUM(CAST(json_extract(je.value, '$.amount') AS REAL) * ?), 0) AS cents
    FROM bills b
    JOIN json_each(
      CASE
        WHEN json_valid(b.payment_details) AND json_type(b.payment_details) = 'array' THEN b.payment_details
        WHEN json_valid(b.payment_details) THEN json_array(b.payment_details)
        ELSE '[]'
      END
    ) je
    WHERE b.paid_at IS NOT NULL AND DATE(b.paid_at) >= ?
      AND json_type(je.value) = 'object'
      AND ${match.clause}
  `).get(minorFactor(), sinceDate, ...match.params) as { cents: number };
  return Math.round(Number(row.cents) || 0);
}

function refundsCents(db: Database.Database, account: CarteraAccount, sinceDate: string): number {
  if (!account.canonical_method) return 0;
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS cents
    FROM refunds WHERE method = ? AND DATE(created_at) >= ?
  `).get(account.canonical_method, sinceDate) as { cents: number };
  return Number(row.cents) || 0;
}

function paidOutCents(db: Database.Database, accountId: number): number {
  const purchases = db.prepare(`
    SELECT COALESCE(SUM(pp.amount_cents), 0) AS cents
    FROM purchase_payments pp
    JOIN purchases p ON p.id = pp.purchase_id
    WHERE pp.account_id = ? AND p.status != 'void'
  `).get(accountId) as { cents: number };
  const payables = db.prepare(`
    SELECT COALESCE(SUM(gpp.amount_cents), 0) AS cents
    FROM general_payable_payments gpp
    JOIN general_payables gp ON gp.id = gpp.payable_id
    WHERE gpp.account_id = ? AND gp.status != 'void'
  `).get(accountId) as { cents: number };
  return Number(purchases.cents || 0) + Number(payables.cents || 0);
}

function entriesNetCents(db: Database.Database, accountId: number): { inflow: number; outflow: number } {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_cents ELSE 0 END), 0) AS inflow,
      COALESCE(SUM(CASE WHEN direction = 'out' THEN amount_cents ELSE 0 END), 0) AS outflow
    FROM cartera_entries WHERE account_id = ? AND voided_at IS NULL
  `).get(accountId) as { inflow: number; outflow: number };
  return { inflow: Number(row.inflow || 0), outflow: Number(row.outflow || 0) };
}

/**
 * Cash on hand, taken from the drawer's own cycle rather than recomputed.
 * With a session open it is what the close screen would show right now; with
 * none open it is what the last close counted.
 */
/** Abierto por arriba: el limite es exclusivo y los sellos de tiempo van al
 *  segundo, asi que usar la hora actual dejaria fuera lo recien registrado. */
export const OPEN_ENDED = '9999-12-31 23:59:59';

export function cashOnHandCents(db: Database.Database): number {
  const session = openCashSession(db);
  if (!session) {
    const lastClosure = db.prepare(`
      SELECT counted_cash_cents FROM cash_closures ORDER BY business_date DESC, id DESC LIMIT 1
    `).get() as { counted_cash_cents: number } | undefined;
    return lastClosure ? Number(lastClosure.counted_cash_cents) : 0;
  }
  const movement = cashMovementSince(db, session.opened_at, OPEN_ENDED, session.id);
  return Number(session.opening_float_cents) + movement.salesCents - movement.refundsCents
    + movement.inflowCents - movement.outflowCents;
}

/**
 * Everything that moved physical cash inside a window. Used both by the
 * account balance above and by the register's expected-cash figure, so the
 * two cannot drift apart.
 */
export function cashMovementSince(
  db: Database.Database,
  start: string,
  end: string,
  sessionId?: number,
): { salesCents: number; refundsCents: number; inflowCents: number; outflowCents: number } {
  const factor = minorFactor();
  const sales = db.prepare(`
    SELECT COALESCE(SUM(CAST(json_extract(je.value, '$.amount') AS REAL) * ?), 0) AS cents
    FROM bills b
    JOIN json_each(
      CASE
        WHEN json_valid(b.payment_details) AND json_type(b.payment_details) = 'array' THEN b.payment_details
        WHEN json_valid(b.payment_details) THEN json_array(b.payment_details)
        ELSE '[]'
      END
    ) je
    WHERE b.paid_at >= ? AND b.paid_at < ?
      AND json_type(je.value) = 'object'
      AND COALESCE(NULLIF(json_extract(je.value, '$.method'), ''), '') = 'cash'
  `).get(factor, start, end) as { cents: number };

  const refunds = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS cents
    FROM refunds WHERE method = 'cash' AND created_at >= ? AND created_at < ?
  `).get(start, end) as { cents: number };

  // Cash movements from cartera are sealed to the session that was open when
  // they happened, so a window never picks up a neighbour's movements.
  const sessionFilter = sessionId === undefined ? '' : 'AND cash_session_id = ?';
  const sessionParam = sessionId === undefined ? [] : [sessionId];

  const entries = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN e.direction = 'in' THEN e.amount_cents ELSE 0 END), 0) AS inflow,
      COALESCE(SUM(CASE WHEN e.direction = 'out' THEN e.amount_cents ELSE 0 END), 0) AS outflow
    FROM cartera_entries e
    JOIN cartera_accounts a ON a.id = e.account_id
    WHERE a.kind = 'cash' AND e.voided_at IS NULL
      AND e.occurred_at >= ? AND e.occurred_at < ? ${sessionFilter}
  `).get(start, end, ...sessionParam) as { inflow: number; outflow: number };

  const purchasePaid = db.prepare(`
    SELECT COALESCE(SUM(pp.amount_cents), 0) AS cents
    FROM purchase_payments pp
    JOIN purchases p ON p.id = pp.purchase_id
    WHERE pp.method = 'cash' AND p.status != 'void'
      AND pp.paid_at >= ? AND pp.paid_at < ? ${sessionFilter.replace('cash_session_id', 'pp.cash_session_id')}
  `).get(start, end, ...sessionParam) as { cents: number };

  const payablePaid = db.prepare(`
    SELECT COALESCE(SUM(gpp.amount_cents), 0) AS cents
    FROM general_payable_payments gpp
    JOIN cartera_accounts a ON a.id = gpp.account_id
    JOIN general_payables gp ON gp.id = gpp.payable_id
    WHERE a.kind = 'cash' AND gp.status != 'void'
      AND gpp.paid_at >= ? AND gpp.paid_at < ? ${sessionFilter.replace('cash_session_id', 'gpp.cash_session_id')}
  `).get(start, end, ...sessionParam) as { cents: number };

  return {
    salesCents: Math.round(Number(sales.cents) || 0),
    refundsCents: Number(refunds.cents) || 0,
    inflowCents: Number(entries.inflow) || 0,
    outflowCents: Number(entries.outflow) + Number(purchasePaid.cents) + Number(payablePaid.cents),
  };
}

export function accountBalance(db: Database.Database, account: CarteraAccount): AccountWithBalance {
  if (account.kind === 'cash') {
    const session = openCashSession(db);
    const movement = session
      ? cashMovementSince(db, session.opened_at, OPEN_ENDED, session.id)
      : { salesCents: 0, refundsCents: 0, inflowCents: 0, outflowCents: 0 };
    return {
      ...account,
      balance_cents: cashOnHandCents(db),
      inflow_cents: movement.salesCents + movement.inflowCents,
      outflow_cents: movement.refundsCents + movement.outflowCents,
    };
  }

  const collections = collectionsCents(db, account, account.opening_as_of);
  const refunds = refundsCents(db, account, account.opening_as_of);
  const paidOut = paidOutCents(db, account.id);
  const entries = entriesNetCents(db, account.id);
  const inflow = collections + entries.inflow;
  const outflow = refunds + paidOut + entries.outflow;
  return {
    ...account,
    balance_cents: Number(account.opening_balance_cents) + inflow - outflow,
    inflow_cents: inflow,
    outflow_cents: outflow,
  };
}

export function accountsWithBalances(db: Database.Database): AccountWithBalance[] {
  return listAccounts(db).map((account) => accountBalance(db, account));
}

// ── Entries ──────────────────────────────────────────────────────────────────

interface EntryInput {
  accountId: number;
  kind: Exclude<EntryKind, 'transfer'>;
  amountCents: number;
  concept: string;
  reference?: string | null;
  userId: string;
}

/**
 * Cash never moves with the drawer closed. Without this, a cash expense
 * recorded outside a session would land in no Z report at all and show up as
 * an unexplained shortfall the next morning.
 */
function requireSessionForCash(db: Database.Database, account: CarteraAccount): number | null {
  if (account.kind !== 'cash') return null;
  const session = openCashSession(db);
  if (!session) throw new CarteraError('Open the register before moving cash', 409);
  return session.id;
}

/**
 * A drawer cannot hand out money it does not hold. Taking more cash than is
 * there is a typo, not a transaction — and letting it through leaves a
 * negative till that no count will ever reconcile. Only reversals are allowed
 * to push a balance below zero, and they do not come through here.
 */
export function assertCashCovers(db: Database.Database, account: CarteraAccount, amountCents: number): void {
  if (account.kind !== 'cash') return;
  const available = cashOnHandCents(db);
  if (amountCents > available) {
    throw new CarteraError(
      `The register holds less than that (${available} available)`,
      409,
    );
  }
}

export function createEntry(db: Database.Database, input: EntryInput): { id: number } {
  const account = getAccount(db, input.accountId);
  if (!account) throw new CarteraError('Account not found', 404);
  if (!account.is_active) throw new CarteraError('Account is inactive');
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new CarteraError('Amount must be a whole number of cents, greater than zero');
  }
  const concept = String(input.concept || '').trim();
  if (!concept) throw new CarteraError('A movement needs a concept');

  const sessionId = requireSessionForCash(db, account);
  if (input.kind === 'expense') assertCashCovers(db, account, input.amountCents);
  const timestamp = now();
  const id = db.prepare(`
    INSERT INTO cartera_entries
      (account_id, kind, direction, amount_cents, concept, reference, occurred_at, business_date, cash_session_id, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    account.id, input.kind, input.kind === 'income' ? 'in' : 'out', input.amountCents,
    concept.slice(0, 200), input.reference?.trim().slice(0, 100) || null,
    timestamp, businessToday(), sessionId, input.userId, timestamp,
  ).lastInsertRowid;
  return { id: Number(id) };
}

export function createTransfer(db: Database.Database, input: {
  fromAccountId: number; toAccountId: number; amountCents: number;
  concept?: string | null; userId: string;
}): { group_id: string } {
  if (input.fromAccountId === input.toAccountId) {
    throw new CarteraError('A transfer needs two different accounts');
  }
  const from = getAccount(db, input.fromAccountId);
  const to = getAccount(db, input.toAccountId);
  if (!from || !to) throw new CarteraError('Account not found', 404);
  if (!from.is_active || !to.is_active) throw new CarteraError('Account is inactive');
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new CarteraError('Amount must be a whole number of cents, greater than zero');
  }

  const fromSession = requireSessionForCash(db, from);
  const toSession = requireSessionForCash(db, to);
  assertCashCovers(db, from, input.amountCents);
  const groupId = `T-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const timestamp = now();
  const date = businessToday();
  const concept = String(input.concept || '').trim().slice(0, 200);

  const insert = db.prepare(`
    INSERT INTO cartera_entries
      (account_id, kind, direction, amount_cents, concept, transfer_group_id, occurred_at, business_date, cash_session_id, created_by, created_at)
    VALUES (?, 'transfer', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(from.id, 'out', input.amountCents, concept || `Traslado a ${to.name}`, groupId, timestamp, date, fromSession, input.userId, timestamp);
  insert.run(to.id, 'in', input.amountCents, concept || `Traslado desde ${from.name}`, groupId, timestamp, date, toSession, input.userId, timestamp);
  return { group_id: groupId };
}

export function voidEntry(db: Database.Database, entryId: number, reason: string, userId: string): void {
  const entry = db.prepare('SELECT * FROM cartera_entries WHERE id = ?').get(entryId) as any;
  if (!entry) throw new CarteraError('Movement not found', 404);
  if (entry.voided_at) throw new CarteraError('Movement is already void', 409);
  if (!reason || !String(reason).trim()) throw new CarteraError('Voiding a movement needs a reason');

  const timestamp = now();
  // Both legs of a transfer go together: half a transfer is not a thing.
  const target = entry.transfer_group_id
    ? db.prepare('UPDATE cartera_entries SET voided_at = ?, voided_by = ?, void_reason = ? WHERE transfer_group_id = ? AND voided_at IS NULL')
    : db.prepare('UPDATE cartera_entries SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL');
  target.run(timestamp, userId, String(reason).trim().slice(0, 300), entry.transfer_group_id ?? entryId);
}

// ── Movements ────────────────────────────────────────────────────────────────

export interface MovementRow {
  id: string;
  occurred_at: string;
  business_date: string;
  account_id: number | null;
  account_name: string | null;
  type: 'collection' | 'income' | 'expense' | 'supplier_payment' | 'payable_payment' | 'transfer';
  concept: string;
  counterparty: string | null;
  reference: string | null;
  in_cents: number;
  out_cents: number;
  voided: boolean;
}

/**
 * One list, four sources. Collections are read from the bills that produced
 * them rather than copied here, which is why a payment can never appear twice
 * or drift from the bill it settled.
 */
export function listMovements(db: Database.Database, limit = 200): MovementRow[] {
  const factor = minorFactor();

  const collections = db.prepare(`
    SELECT b.id AS bill_id, b.bill_number, b.paid_at, c.name AS customer_name,
           json_extract(je.value, '$.method') AS method,
           CAST(json_extract(je.value, '$.payment_method_id') AS INTEGER) AS payment_method_id,
           CAST(json_extract(je.value, '$.amount') AS REAL) AS amount,
           json_extract(je.value, '$.timestamp') AS line_at
    FROM bills b
    LEFT JOIN customers c ON c.id = b.customer_id
    JOIN json_each(
      CASE
        WHEN json_valid(b.payment_details) AND json_type(b.payment_details) = 'array' THEN b.payment_details
        WHEN json_valid(b.payment_details) THEN json_array(b.payment_details)
        ELSE '[]'
      END
    ) je
    WHERE json_type(je.value) = 'object' AND b.paid_at IS NOT NULL
    ORDER BY b.paid_at DESC
    LIMIT ?
  `).all(limit) as any[];

  const accounts = listAccounts(db, true);
  const byCanonical = new Map(accounts.filter((a) => a.canonical_method).map((a) => [a.canonical_method, a]));
  const byMethodId = new Map(accounts.filter((a) => a.payment_method_id !== null).map((a) => [a.payment_method_id, a]));

  const rows: MovementRow[] = collections.map((row) => {
    const account = row.payment_method_id ? byMethodId.get(row.payment_method_id) : byCanonical.get(row.method);
    return {
      id: `bill:${row.bill_id}:${row.line_at || row.paid_at}`,
      occurred_at: row.line_at || row.paid_at,
      business_date: localDateInTimezone(parseDbTimestamp(row.line_at || row.paid_at), tenantTimezone()),
      account_id: account?.id ?? null,
      account_name: account?.name ?? String(row.method || ''),
      type: 'collection',
      concept: row.bill_number,
      counterparty: row.customer_name,
      reference: row.bill_number,
      in_cents: Math.round(Number(row.amount || 0) * factor),
      out_cents: 0,
      voided: false,
    };
  });

  for (const entry of db.prepare(`
    SELECT e.*, a.name AS account_name FROM cartera_entries e
    JOIN cartera_accounts a ON a.id = e.account_id
    ORDER BY e.occurred_at DESC LIMIT ?
  `).all(limit) as any[]) {
    rows.push({
      id: `entry:${entry.id}`,
      occurred_at: entry.occurred_at,
      business_date: entry.business_date,
      account_id: entry.account_id,
      account_name: entry.account_name,
      type: entry.kind === 'transfer' ? 'transfer' : entry.kind,
      concept: entry.concept,
      counterparty: null,
      reference: entry.reference || entry.transfer_group_id,
      in_cents: entry.direction === 'in' ? entry.amount_cents : 0,
      out_cents: entry.direction === 'out' ? entry.amount_cents : 0,
      voided: !!entry.voided_at,
    });
  }

  for (const payment of db.prepare(`
    SELECT pp.*, a.name AS account_name, p.purchase_number, p.status, s.name AS supplier_name
    FROM purchase_payments pp
    JOIN purchases p ON p.id = pp.purchase_id
    JOIN suppliers s ON s.id = p.supplier_id
    LEFT JOIN cartera_accounts a ON a.id = pp.account_id
    ORDER BY pp.paid_at DESC LIMIT ?
  `).all(limit) as any[]) {
    rows.push({
      id: `purchase:${payment.id}`,
      occurred_at: payment.paid_at,
      business_date: payment.business_date,
      account_id: payment.account_id,
      account_name: payment.account_name || payment.method,
      type: 'supplier_payment',
      concept: payment.purchase_number,
      counterparty: payment.supplier_name,
      reference: payment.purchase_number,
      in_cents: 0,
      out_cents: payment.amount_cents,
      voided: payment.status === 'void',
    });
  }

  for (const payment of db.prepare(`
    SELECT gpp.*, a.name AS account_name, gp.payable_number, gp.payee_name, gp.concept, gp.status
    FROM general_payable_payments gpp
    JOIN general_payables gp ON gp.id = gpp.payable_id
    JOIN cartera_accounts a ON a.id = gpp.account_id
    ORDER BY gpp.paid_at DESC LIMIT ?
  `).all(limit) as any[]) {
    rows.push({
      id: `payable:${payment.id}`,
      occurred_at: payment.paid_at,
      business_date: payment.business_date,
      account_id: payment.account_id,
      account_name: payment.account_name,
      type: 'payable_payment',
      concept: payment.concept,
      counterparty: payment.payee_name,
      reference: payment.payable_number,
      in_cents: 0,
      out_cents: payment.amount_cents,
      voided: payment.status === 'void',
    });
  }

  rows.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0));
  return rows.slice(0, limit);
}
