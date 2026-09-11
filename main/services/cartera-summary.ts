/**
 * The Resumen tab: one read that answers "how am I doing".
 *
 * Every figure here is derived from the same places the detail tabs read, so
 * the summary can never say something the lists contradict.
 */
import type Database from 'better-sqlite3';

import {
  OPEN_ENDED, accountsWithBalances, businessToday, cashMovementSince, listAccounts,
  minorFactor, openCashSession, tenantTimezone,
} from './cartera';
import { listPayables, bucketFor, type AgeBucket } from './payables';
import { listReceivables } from './receivables';

type Buckets = Record<AgeBucket, number>;

const emptyBuckets = (): Buckets => ({ current: 0, week: 0, month: 0, overdue: 0 });

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const result = new Date(Date.UTC(y, m - 1, d));
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

export function carteraSummary(db: Database.Database) {
  const factor = minorFactor();
  const today = businessToday();

  const accounts = accountsWithBalances(db);
  const cashAvailable = accounts.filter((a) => a.kind === 'cash').reduce((sum, a) => sum + a.balance_cents, 0);
  const bankAvailable = accounts.filter((a) => a.kind !== 'cash').reduce((sum, a) => sum + a.balance_cents, 0);

  // Receivables are stored in the bills' own major units; payables are in
  // cents. Everything leaves this function in cents so the screen formats once.
  const receivables = listReceivables(db, tenantTimezone());
  const receivableBuckets = emptyBuckets();
  for (const row of receivables.rows) {
    receivableBuckets[row.age_bucket] += Math.round(Number(row.balance) * factor);
  }

  const payables = listPayables(db);
  const payableBuckets = emptyBuckets();
  for (const row of payables.rows) payableBuckets[row.age_bucket] += row.balance_cents;

  const receivableTotal = Math.round(receivables.summary.total_balance * factor);
  const receivableOverdue = Math.round(receivables.summary.overdue_balance * factor);

  // Projection: only what is still ahead of its due date counts as an
  // expected movement. Anything already overdue is money that should have
  // arrived, not money the next thirty days will bring.
  const projection = [7, 14, 21, 30].map((days) => {
    const cutoff = addDays(today, days);
    const incoming = receivables.rows
      .filter((row) => row.due_date && row.due_date > today && row.due_date <= cutoff)
      .reduce((sum, row) => sum + Math.round(Number(row.balance) * factor), 0);
    const outgoing = payables.rows
      .filter((row) => row.due_date > today && row.due_date <= cutoff)
      .reduce((sum, row) => sum + row.balance_cents, 0);
    return {
      days,
      incoming_cents: incoming,
      outgoing_cents: outgoing,
      net_cents: incoming - outgoing,
      projected_cash_cents: cashAvailable + bankAvailable + incoming - outgoing,
    };
  });

  // Today's movement, across every account.
  const todayRow = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_cents ELSE 0 END), 0) AS inflow,
      COALESCE(SUM(CASE WHEN direction = 'out' THEN amount_cents ELSE 0 END), 0) AS outflow
    FROM cartera_entries WHERE business_date = ? AND voided_at IS NULL
  `).get(today) as { inflow: number; outflow: number };

  const todayCollections = db.prepare(`
    SELECT b.bill_number, b.paid_at, c.name AS customer_name,
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
    WHERE json_type(je.value) = 'object' AND DATE(b.paid_at) = ?
    ORDER BY b.paid_at DESC
    LIMIT 25
  `).all(today) as any[];

  const allAccounts = listAccounts(db, true);
  const byCanonical = new Map(allAccounts.filter((a) => a.canonical_method).map((a) => [a.canonical_method, a]));
  const byMethodId = new Map(allAccounts.filter((a) => a.payment_method_id !== null).map((a) => [a.payment_method_id, a]));

  const collectionsToday = todayCollections.map((row) => {
    const account = row.payment_method_id ? byMethodId.get(row.payment_method_id) : byCanonical.get(row.method);
    return {
      bill_number: row.bill_number,
      at: row.line_at || row.paid_at,
      customer_name: row.customer_name,
      account_name: account?.name ?? String(row.method || ''),
      amount_cents: Math.round(Number(row.amount || 0) * factor),
    };
  });
  const collectedTodayCents = collectionsToday.reduce((sum, row) => sum + row.amount_cents, 0);

  // Register card: the same numbers the close screen shows, not a second copy.
  const session = openCashSession(db);
  const cashMovement = session
    ? cashMovementSince(db, session.opened_at, OPEN_ENDED, session.id)
    : { salesCents: 0, refundsCents: 0, inflowCents: 0, outflowCents: 0 };
  const register = session
    ? {
      open: true,
      business_date: session.business_date,
      opening_float_cents: Number(session.opening_float_cents),
      cash_in_cents: cashMovement.salesCents + cashMovement.inflowCents,
      cash_out_cents: cashMovement.refundsCents + cashMovement.outflowCents,
      expected_cash_cents: Number(session.opening_float_cents)
        + cashMovement.salesCents - cashMovement.refundsCents
        + cashMovement.inflowCents - cashMovement.outflowCents,
    }
    : { open: false, business_date: today, opening_float_cents: 0, cash_in_cents: 0, cash_out_cents: 0, expected_cash_cents: 0 };

  const availableTotal = cashAvailable + bankAvailable;

  return {
    accounts,
    available: {
      total_cents: availableTotal,
      cash_cents: cashAvailable,
      bank_cents: bankAvailable,
    },
    receivables: {
      total_cents: receivableTotal,
      overdue_cents: receivableOverdue,
      customer_count: receivables.summary.customer_count,
      buckets: receivableBuckets,
    },
    payables: {
      total_cents: payables.summary.total_balance_cents,
      overdue_cents: payables.summary.overdue_balance_cents,
      payee_count: payables.summary.payee_count,
      buckets: payableBuckets,
      covered_by_cash: availableTotal >= payables.summary.total_balance_cents,
    },
    today: {
      inflow_cents: Number(todayRow.inflow) + collectedTodayCents,
      outflow_cents: Number(todayRow.outflow),
      net_cents: Number(todayRow.inflow) + collectedTodayCents - Number(todayRow.outflow),
    },
    net_position_cents: availableTotal + receivableTotal - payables.summary.total_balance_cents,
    projection,
    collections_today: collectionsToday,
    register,
  };
}
