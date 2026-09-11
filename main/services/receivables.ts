/**
 * Receivables (fiado): what customers owe.
 *
 * This module holds no balance of its own. `bills.balance` is the balance —
 * a fiado is simply a bill that has not been fully paid. `receivable_terms`
 * adds the one thing a bill does not have: a due date. Collecting a payment
 * goes through the bill payment route that already exists
 * (`POST /api/bills/:id/payment`), never through a path of its own, so there
 * is never a second number that can disagree with the first.
 */
import type Database from 'better-sqlite3';
import { localDateInTimezone, parseDbTimestamp } from '../db';

export type AgeBucket = 'current' | 'week' | 'month' | 'overdue';

export interface ReceivableRow {
  bill_id: number;
  bill_number: string;
  customer_id: string;
  customer_name: string;
  customer_phone: string | null;
  total: number;
  paid_amount: number;
  balance: number;
  payment_status: string;
  created_at: string;
  due_date: string | null;
  notes: string | null;
  age_bucket: AgeBucket;
  days_overdue: number;
}

export interface ReceivablesSummary {
  total_balance: number;
  overdue_balance: number;
  customer_count: number;
}

function daysBetween(fromDate: string, toDate: string): number {
  const [fy, fm, fd] = fromDate.split('-').map(Number);
  const [ty, tm, td] = toDate.split('-').map(Number);
  const from = Date.UTC(fy, fm - 1, fd);
  const to = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / 86_400_000);
}

function bucketFor(daysOverdue: number): AgeBucket {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 7) return 'week';
  if (daysOverdue <= 30) return 'month';
  return 'overdue';
}

export function listReceivables(db: Database.Database, timezone: string): {
  rows: ReceivableRow[];
  summary: ReceivablesSummary;
} {
  const today = localDateInTimezone(new Date(), timezone);

  const raw = db.prepare(`
    SELECT b.id AS bill_id, b.bill_number, b.customer_id, c.name AS customer_name, c.phone AS customer_phone,
           b.total, b.paid_amount, b.balance, b.payment_status, b.created_at,
           rt.due_date, rt.notes
    FROM bills b
    JOIN customers c ON c.id = b.customer_id
    LEFT JOIN receivable_terms rt ON rt.bill_id = b.id
    WHERE b.payment_status IN ('unpaid', 'partial') AND b.customer_id IS NOT NULL
  `).all() as Array<{
    bill_id: number; bill_number: string; customer_id: string; customer_name: string;
    customer_phone: string | null; total: number; paid_amount: number; balance: number;
    payment_status: string; created_at: string; due_date: string | null; notes: string | null;
  }>;

  const rows: ReceivableRow[] = raw.map((row) => {
    // No due date set → due the day it was billed. That is the ordinary
    // meaning of an unpaid sale with no explicit terms: payable on the spot.
    const anchor = row.due_date ?? localDateInTimezone(parseDbTimestamp(row.created_at), timezone);
    const daysOverdue = Math.max(0, daysBetween(anchor, today));
    return { ...row, age_bucket: bucketFor(daysOverdue), days_overdue: daysOverdue };
  });

  rows.sort((a, b) => b.days_overdue - a.days_overdue || a.bill_number.localeCompare(b.bill_number));

  const summary: ReceivablesSummary = {
    total_balance: rows.reduce((sum, row) => sum + Number(row.balance), 0),
    overdue_balance: rows
      .filter((row) => row.age_bucket !== 'current')
      .reduce((sum, row) => sum + Number(row.balance), 0),
    customer_count: new Set(rows.map((row) => row.customer_id)).size,
  };

  return { rows, summary };
}

export class ReceivableError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function setReceivableTerms(
  db: Database.Database,
  billId: number,
  input: { due_date: string; notes?: string | null; userId: string },
): void {
  const bill = db.prepare(
    `SELECT id, customer_id, payment_status FROM bills WHERE id = ?`,
  ).get(billId) as { id: number; customer_id: string | null; payment_status: string } | undefined;
  if (!bill) throw new ReceivableError('Bill not found', 404);
  if (!bill.customer_id) throw new ReceivableError('Bill has no customer to owe this balance');
  if (!ISO_DATE.test(input.due_date)) throw new ReceivableError('due_date must be YYYY-MM-DD');

  const timestamp = new Date().toISOString().replace('T', ' ').replace(/\..*$/, '');
  db.prepare(`
    INSERT INTO receivable_terms (bill_id, due_date, notes, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(bill_id) DO UPDATE SET
      due_date = excluded.due_date, notes = excluded.notes, updated_at = excluded.updated_at
  `).run(billId, input.due_date, input.notes ?? null, input.userId, timestamp, timestamp);
}
