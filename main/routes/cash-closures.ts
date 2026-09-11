/**
 * Day-close (cierre de caja, issue #649).
 *
 * One close per store per tenant-local day. POST /api/cash-closures:
 *  - Owner-only (manager/cashier/server are 403).
 *  - Validates: YYYY-MM-DD format, not in the future, integer cents >= 0.
 *  - Recomputes the day's aggregates server-side (never trusts client totals)
 *    using the verbatim financial-summary template (main/routes/reports.ts)
 *    for display totals, plus two spec-mandated drawer-reality deviations:
 *      * `expected_cash_cents`: raw pre-join `method = 'cash'` filter; refunds
 *        by `refunds.created_at` (the day the cash left the drawer, not the
 *        day the original bill was paid).
 *      * `tax_components_json`: aggregated via `aggregateTaxComponents`
 *        against the spec's DisplayTaxComponent[] shape, so Z rows carry the
 *        same tax components the live report endpoint returns.
 *      * payment-method lines keyed by `b.paid_at` (not per-line timestamps)
 *        so an installment-paid bill lands whole on its settlement day,
 *        reconciling with gross/staff/tax; live reports keep per-line keys.
 *  - Snapshots the result with the operator's counted cash and stores one
 *    immutable row in `cash_closures`. Duplicate POST against the same
 *    `business_date` (scope='day') is rejected with 409 via SELECT-then-INSERT
 *    inside `withTxn`; the partial index `cash_closures_one_day` is the
 *    concurrency safety net.
 *
 * Sales flow is deliberately untouched: `createRefund`, `shift_id`, and
 * `refunds.shift_id` are unchanged — the drawer-reality attribution
 * (cash refunds by `refunds.created_at`) is read straight from the existing
 * `refunds` table without backfilling any column. The `scope='session'`
 * extension door is intentionally unused by this endpoint; session-style
 * closes arrive as separate rows with a different `scope` value.
 */
import { Router, Request, Response } from 'express';
import {
  dayBoundsInTimezone, getDatabase, getSettingValue, localDateInTimezone, now, withTxn,
} from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import { nextZNumber } from '../db';
import { getTenantCurrency } from '../services/refund';
import { getCurrencyMinorUnitFactor } from '../countries';
import { getOrdersWithItemsForBills } from './bills';
import { getHttpRequestSignal } from '../shutdown';
import { getOpenCashSession } from './cash-sessions';
import {
  DisplayTaxComponent,
  aggregateTaxComponents,
} from '../services/tax-components';

const router = Router();
const MAX_NOTES_LENGTH = 500;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

function tenantTimezone(): string {
  return getSettingValue('timezone') || 'Asia/Kolkata';
}

function validateBusinessDate(raw: unknown): string {
  if (typeof raw !== 'string' || !ISO_DATE_RE.test(raw)) {
    throw httpError('business_date must use YYYY-MM-DD format', 400);
  }
  // Real-calendar-date guard: `Date.UTC(2026, 1, 30)` silently rolls over
  // into March, so a regex match is not enough. Round-trip the parsed
  // year/month/day and confirm the calendar matches the input.
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(5, 7));
  const day = Number(raw.slice(8, 10));
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() + 1 !== month ||
    roundTrip.getUTCDate() !== day
  ) {
    throw httpError('business_date is not a real calendar date', 400);
  }
  // Tenant-local today, not the host UTC clock: a date that is "today" in
  // the store's configured timezone must never be rejected as future even
  // when the host's UTC clock is still on yesterday. ISO date arithmetic on
  // the YYYY-MM-DD string is timezone-safe.
  const todayLocal = localDateInTimezone(new Date(), tenantTimezone());
  if (raw > todayLocal) {
    throw httpError('business_date cannot be in the future', 400);
  }
  return raw;
}

function validateCents(raw: unknown, field: string, allowZero = true): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw httpError(`${field} must be an integer`, 400);
  }
  if (raw < 0 || (!allowZero && raw === 0)) {
    throw httpError(`${field} must be >= ${allowZero ? 0 : 1}`, 400);
  }
  if (!Number.isSafeInteger(raw)) {
    throw httpError(`${field} is out of range`, 400);
  }
  return raw;
}

/**
 * Shape a stored `cash_closures` row into the snapshot the print primitive
 * consume. Single source of truth so the print body and the on-screen
 * Z share shape — the operator sees in the modal exactly what the printer
 * receives.
 * the operator's screen byte for byte:
 *  - `closed_by_name` resolves the operator's `users.name`, falling back
 *    to the raw id when the row was orphaned (staff deletion, etc.).
 *  - JSON columns (`payment_methods_json`, `staff_sales_json`,
 *    `tax_components_json`) are parsed into typed arrays; empty / invalid
 *    JSON becomes `[]` so the body builder renders "(none)" rather
 *    than blowing up.
 *  - `__isReprint` is the synthetic flag the body builder uses to add
 *    the REIMPRESION marker; caller passes `true` for reprints.
 */
function shapeZReportSnapshot(db: ReturnType<typeof getDatabase>, row: any, isReprint: boolean): any {
  const userRow = db.prepare(`SELECT name FROM users WHERE id = ?`).get(row.closed_by) as { name: string } | undefined;
  const safeJson = (raw: string | null | undefined, fallback: any[] = []): any[] => {
    if (!raw) return fallback;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch (err) {
      // F5: a corrupt JSON column on an immutable financial document must
      // surface, not silently mask as an empty section. The handler that
      // built the row already validated input; if we reach here the stored
      // data is the problem and the operator deserves to know which section
      // is empty so they can verify against the live report before reissuing.
      console.warn('[CashClosures] safeJson: corrupt stored JSON, falling back:', err instanceof Error ? err.message : err);
      return fallback;
    }
  };
  return {
    ...row,
    closed_by_name: userRow?.name ?? row.closed_by,
    payment_methods: safeJson(row.payment_methods_json, []),
    staff_sales: safeJson(row.staff_sales_json, []),
    tax_components: safeJson(row.tax_components_json, []),
    __isReprint: isReprint,
  };
}

interface PaymentMethodRow {
  method: string;
  count: number;
  total: number;
}

interface StaffSalesRow {
  user_id: string;
  name: string;
  role: string;
  revenue: number;
  orderCount: number;
}

export interface DayAggregates {
  billCount: number;
  refundCount: number;
  grossCollectedCents: number;
  refundedCents: number;
  netCollectedCents: number;
  cashSalesCents: number;
  cashRefundsByCreatedAtCents: number;
  /**
   * Cash that moved through Cartera inside the same window: manual income and
   * expenses, transfers to and from the drawer, and what was paid out to
   * suppliers or on a bill. Zero by construction when the module has never
   * been used, so a store that does not use it sees the same numbers as before.
   */
  carteraCashInCents: number;
  carteraCashOutCents: number;
  paymentMethods: { method: string; count: number; total_cents: number }[];
  staffSales: { user_id: string; name: string; role: string; revenue_cents: number; orderCount: number }[];
  taxComponents: DisplayTaxComponent[];
}

/**
 * Shared by financial-summary (reports.ts, called with paidOnly/attributeRefundsToBillDate=true)
 * and cash-closure snapshots; defaults false/false/false.
 *
 * `keyByPaidAt` is true only for the day-close snapshot: a bill paid in
 * installments carries one `timestamp` per payment line, so keying lines
 * by their own timestamp would scatter one bill's cash across several
 * business days while gross/staff/tax (all keyed by `b.paid_at`) land on
 * the settlement day. Keying by `paid_at` keeps every Z section on the
 * same day so the immutable snapshot reconciles with itself. Live reports
 * keep the default: a partial payment belongs to the day it was taken.
 */
export function paymentMethodBreakdown(
  db: ReturnType<typeof getDatabase>,
  startDate: string,
  endDate: string = startDate,
  paidOnly: boolean = false,
  attributeRefundsToBillDate: boolean = false,
  keyByPaidAt: boolean = false,
): PaymentMethodRow[] {
  const [start] = dayBoundsInTimezone(startDate, tenantTimezone());
  const [, end] = dayBoundsInTimezone(endDate, tenantTimezone());
  const minorFactor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
  return db.prepare(`
    WITH payment_lines AS (
      SELECT b.paid_at, b.created_at, je.value AS line
      FROM bills b
      JOIN json_each(CASE
        WHEN json_valid(b.payment_details) AND json_type(b.payment_details) = 'array'
          THEN b.payment_details
        WHEN json_valid(b.payment_details)
          THEN json_array(b.payment_details)
        ELSE '[]'
      END) je
      WHERE b.payment_details IS NOT NULL
        AND b.created_at < ?
        AND (b.paid_at IS NULL OR b.paid_at >= ?)
        AND (? = 0 OR b.paid_at IS NOT NULL)
        AND json_type(je.value) = 'object'
    ), normalized AS (
      SELECT
        COALESCE(NULLIF(json_extract(line, '$.method'), ''), 'unknown') AS method,
        CAST(json_extract(line, '$.payment_method_id') AS INTEGER) AS payment_method_id,
        json_extract(line, '$.amount') AS amount,
        COALESCE(
          datetime(NULLIF(CASE WHEN ? = 1 THEN NULL ELSE json_extract(line, '$.timestamp') END, '')),
          datetime(NULLIF(paid_at, '')),
          datetime(NULLIF(created_at, ''))
        ) AS payment_time
      FROM payment_lines
      UNION ALL
      SELECT r.method, NULL, -(CAST(r.amount_cents AS REAL) / ?),
        datetime(CASE WHEN ? = 1 THEN b.paid_at ELSE r.created_at END)
      FROM refunds r
      JOIN bills b ON b.id = r.bill_id
    )
    SELECT COALESCE(pm.name, normalized.method) AS method, COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN typeof(amount) IN ('integer', 'real') THEN amount ELSE 0 END), 0) AS total
    FROM normalized LEFT JOIN payment_methods pm ON pm.id = normalized.payment_method_id
    WHERE payment_time >= datetime(?) AND payment_time < datetime(?)
    GROUP BY COALESCE(pm.name, normalized.method)
    ORDER BY total DESC
  `).all(end, start, paidOnly ? 1 : 0, keyByPaidAt ? 1 : 0, minorFactor, attributeRefundsToBillDate ? 1 : 0, start, end) as PaymentMethodRow[];
}

/**
 * Recompute every snapshot field for one tenant-local business_date.
 *
 * Display totals deliberately include cancelled-order bills: a paid bill's
 * cash already left the drawer and remains there until counted, regardless
 * of the order's later status. `financial-summary` does not apply a
 * cancelled-order filter either — this snapshot matches its display
 * totals by construction. The two spec-mandated drawer-reality deviations
 * (`expected_cash_cents` cash-only raw filter and refunds-by-created_at)
 * are applied separately so the rest of the snapshot reconciles with
 * financial-summary.
 *
 * Exported so Wave 3 (the live X-report) can reuse this pipeline without
 * duplicating the template or the tax-components hydration. Returns a
 * plain `DayAggregates` shape already converted to INTEGER minor units.
 */
export function computeDayAggregates(
  db: ReturnType<typeof getDatabase>,
  businessDate: string,
  /** Ventana explícita [inicio, fin). Sin ella se usa el día comercial completo. */
  bounds?: [string, string],
): DayAggregates {
  const [start, end] = bounds ?? dayBoundsInTimezone(businessDate, tenantTimezone());

  // Display gross — `SUM(paid_amount)` over the paid_at day window (NOT
  // SUM(total) over created_at). This matches financial-summary so display
  // totals reconcile with the existing report endpoint for the same day.
  const billRow = db.prepare(`
    SELECT
      COUNT(*) AS bill_count,
      COALESCE(SUM(b.paid_amount), 0) AS gross_collected
    FROM bills b
    WHERE b.paid_at >= ? AND b.paid_at < ?
  `).get(start, end) as { bill_count: number; gross_collected: number };

  // Display refunds — paid_at attribution, same as financial-summary.
  // Stored as INTEGER cents to match the `refunded_cents` column type and the
  // schema convention (`bills.paid_amount`, `refunds.amount_cents`). Display
  // / response-edge conversion happens only at the { zReport } boundary, never
  // in storage or in the storage-time net subtraction.
  const refundRow = db.prepare(`
    SELECT
      COUNT(*) AS refund_count,
      COALESCE(SUM(r.amount_cents), 0) AS refunded_cents
    FROM refunds r
    JOIN bills b ON b.id = r.bill_id
    WHERE b.paid_at >= ? AND b.paid_at < ?
  `).get(start, end) as { refund_count: number; refunded_cents: number };

  // cash sales (drawer-reality side of the split): raw pre-join `method='cash'`
  // filter, paid_at window, no `payment_methods` name join. Reads amount via
  // json_extract on the line object (the same scalar format used elsewhere).
  // Cash refunds by `created_at` (drawer reality: cash left the drawer on
  // the day the refund was issued, not the day the original bill was paid).
  // `minorFactor` is bound as a SQL parameter (matching the refund CTE
  // pattern immediately below) so non-100 currencies (KWD factor 1000,
  // JPY factor 1) round-trip exactly.
  const minorFactor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
  const cashDrawerRow = db.prepare(`
    WITH cash_sales AS (
      SELECT COALESCE(SUM(CAST(json_extract(je.value, '$.amount') AS REAL) * ?), 0) AS sales_cents
      FROM bills b
      JOIN json_each(
        CASE
          WHEN json_valid(b.payment_details) AND json_type(b.payment_details) = 'array'
            THEN b.payment_details
          WHEN json_valid(b.payment_details)
            THEN json_array(b.payment_details)
          ELSE '[]'
        END
      ) je
      WHERE b.paid_at >= ? AND b.paid_at < ?
        AND json_type(je.value) = 'object'
        AND COALESCE(NULLIF(json_extract(je.value, '$.method'), ''), '') = 'cash'
    ), cash_refunds AS (
      SELECT COALESCE(SUM(amount_cents), 0) AS refunds_cents
      FROM refunds
      WHERE method = 'cash'
        AND created_at >= ? AND created_at < ?
    )
    SELECT
      (SELECT sales_cents FROM cash_sales) AS sales_cents,
      (SELECT refunds_cents FROM cash_refunds) AS refunds_cents
  `).get(minorFactor, start, end, start, end) as { sales_cents: number; refunds_cents: number };

  // Cash that moved through Cartera in this same window. Sealed to the window
  // by `occurred_at`/`paid_at` exactly like the sales above, so a shift never
  // picks up the neighbouring one's movements. Both sums are zero on a store
  // that has never opened the module, which is what lets the expected-cash
  // formula grow without changing any existing store's numbers.
  const carteraCashRow = db.prepare(`
    SELECT
      COALESCE((
        SELECT SUM(CASE WHEN e.direction = 'in' THEN e.amount_cents ELSE 0 END)
        FROM cartera_entries e JOIN cartera_accounts a ON a.id = e.account_id
        WHERE a.kind = 'cash' AND e.voided_at IS NULL AND e.occurred_at >= ? AND e.occurred_at < ?
      ), 0) AS in_cents,
      COALESCE((
        SELECT SUM(CASE WHEN e.direction = 'out' THEN e.amount_cents ELSE 0 END)
        FROM cartera_entries e JOIN cartera_accounts a ON a.id = e.account_id
        WHERE a.kind = 'cash' AND e.voided_at IS NULL AND e.occurred_at >= ? AND e.occurred_at < ?
      ), 0) AS entries_out_cents,
      COALESCE((
        SELECT SUM(pp.amount_cents)
        FROM purchase_payments pp
        JOIN purchases p ON p.id = pp.purchase_id
        -- Matched by method, not by treasury account: paying a supplier in
        -- cash empties the drawer whether or not Cartera is set up.
        WHERE pp.method = 'cash' AND p.status != 'void' AND pp.paid_at >= ? AND pp.paid_at < ?
      ), 0) AS purchases_out_cents,
      COALESCE((
        SELECT SUM(gpp.amount_cents)
        FROM general_payable_payments gpp
        JOIN cartera_accounts a ON a.id = gpp.account_id
        JOIN general_payables gp ON gp.id = gpp.payable_id
        WHERE a.kind = 'cash' AND gp.status != 'void' AND gpp.paid_at >= ? AND gpp.paid_at < ?
      ), 0) AS payables_out_cents
  `).get(start, end, start, end, start, end, start, end) as {
    in_cents: number; entries_out_cents: number; purchases_out_cents: number; payables_out_cents: number;
  };
  const carteraCash = {
    inCents: Number(carteraCashRow.in_cents || 0),
    outCents: Number(carteraCashRow.entries_out_cents || 0)
      + Number(carteraCashRow.purchases_out_cents || 0)
      + Number(carteraCashRow.payables_out_cents || 0),
  };

  // Display payment-method totals — reuse paymentMethodBreakdown so display
  // numbers reconcile with the live financial-summary endpoint for the same day.
  // Keyed by paid_at (not per-line timestamps) so installment payments
  // land on the settlement day alongside gross/staff/tax (see B1 above).
  const paymentMethodsRows = paymentMethodBreakdown(db, businessDate, businessDate, true, true, true);

  // Per-staff sales — same window as the bill count, keyed by paid_at so a
  // cross-midnight bill (created day-1, paid day-2) rolls into day-2's Z
  // (matches the gross/payment/expected windows above; cancels the prior
  // creation-time key, which produced a non-reconciling Z with respect to
  // the rest of the snapshot). Unpaid orders drop out: uncollected money
  // is not staff revenue for the day it was created.
  const staffSalesRows = db.prepare(`
    SELECT u.id AS user_id, u.name AS name, u.role AS role,
      COALESCE(SUM(b.paid_amount), 0) AS revenue,
      COUNT(b.id) AS orderCount
    FROM bills b
    JOIN orders o ON o.id = b.order_id
    JOIN users u ON u.id = o.user_id
    WHERE b.paid_at >= ? AND b.paid_at < ?
    GROUP BY u.id
    ORDER BY revenue DESC
    LIMIT 20
  `).all(start, end) as StaffSalesRow[];

  // Tax components — keyed by paid_at window to stay reconciled with the
  // rest of the Z. Bills are hydrated with their order items and then
  // aggregated via the existing `aggregateTaxComponents` pipeline, unchanged.
  // Unpaid bills drop out by the same logic as the staff query above.
  const bills = db.prepare(`
    SELECT b.*
    FROM bills b
    WHERE b.paid_at >= ? AND b.paid_at < ?
    ORDER BY b.paid_at, b.id
  `).all(start, end) as any[];
  const orders = getOrdersWithItemsForBills(db, bills);
  const taxDocuments = bills.map((bill) => ({
    tax_amount: bill.tax_amount,
    tax_snapshot: bill.tax_snapshot,
    tax_breakdown: bill.tax_breakdown,
    items: orders.get(Number(bill.id))?.items || [],
  }));
  const taxComponents = aggregateTaxComponents(taxDocuments);

  const grossCollectedCents = Math.round(Number(billRow.gross_collected || 0) * minorFactor);
  const refundedCents = Number(refundRow.refunded_cents || 0);

  return {
    billCount: Number(billRow.bill_count || 0),
    refundCount: Number(refundRow.refund_count || 0),
    grossCollectedCents,
    refundedCents,
    netCollectedCents: grossCollectedCents - refundedCents,
    cashSalesCents: Math.round(Number(cashDrawerRow.sales_cents || 0)),
    cashRefundsByCreatedAtCents: Number(cashDrawerRow.refunds_cents || 0),
    carteraCashInCents: carteraCash.inCents,
    carteraCashOutCents: carteraCash.outCents,
    paymentMethods: paymentMethodsRows.map((row) => ({
      method: row.method,
      count: Number(row.count || 0),
      total_cents: Math.round(Number(row.total || 0) * minorFactor),
    })),
    staffSales: staffSalesRows.map((row) => ({
      user_id: row.user_id,
      name: row.name,
      role: row.role,
      revenue_cents: Math.round(Number(row.revenue || 0) * minorFactor),
      orderCount: Number(row.orderCount || 0),
    })),
    taxComponents,
  };
}

router.post('/', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const businessDate = validateBusinessDate(body.business_date);
    const openingFloatCents = validateCents(body.opening_float_cents, 'opening_float_cents');
    const countedCashCents = validateCents(body.counted_cash_cents, 'counted_cash_cents');
    if (typeof body.notes === 'string' && body.notes.length > MAX_NOTES_LENGTH) {
      throw httpError('notes is too long', 400);
    }
    const notes = typeof body.notes === 'string' ? body.notes : null;
    const closedBy = String((req as any).user?.userId || '');
    if (!closedBy) throw httpError('Authentication required', 401);

    const db = getDatabase();
    const [periodStart, periodEnd] = dayBoundsInTimezone(businessDate, tenantTimezone());

    // SELECT-then-INSERT inside withTxn matches the customers.ts uniqueness
    // pattern; the partial index `cash_closures_one_day ... WHERE scope='day'`
    // is the concurrency safety net (a concurrent winner sees 409 here, a
    // race that slips past SELECT hits SQLITE_CONSTRAINT, mapped below).
    const result = withTxn(() => {
      // Con una caja abierta el cierre es de turno: cuenta sólo su ventana y
      // toma el fondo declarado al abrir. Sin caja abierta se conserva el
      // cierre por día de siempre, uno por fecha.
      const openSession = getOpenCashSession(db) as any;
      const scope: 'day' | 'session' = openSession ? 'session' : 'day';
      if (!openSession) {
        const existing = db.prepare(
          `SELECT id FROM cash_closures WHERE business_date = ? AND scope = 'day' LIMIT 1`
        ).get(businessDate);
        if (existing) {
          throw httpError('This day is already closed', 409);
        }
      }

      const closingAt = now();
      const aggregates = openSession
        ? computeDayAggregates(db, businessDate, [String(openSession.opened_at), closingAt])
        : computeDayAggregates(db, businessDate);

      // Con caja abierta manda el fondo declarado al abrirla: es el dato que
      // el operador recibió en el cajón, no uno tecleado al final del turno.
      const effectiveFloatCents = openSession
        ? Number(openSession.opening_float_cents)
        : openingFloatCents;

      // Snapshot math:
      // expected = opening_float + cashSales − cashRefunds(created_at)
      //            + carteraCashIn − carteraCashOut
      // variance = counted − expected
      //
      // The two Cartera terms are zero by construction when nothing moved
      // through the module, so this is the original formula for every store
      // that does not use it. When it is used, the drawer and the report agree
      // because both read the same rows.
      const expectedCashCents = effectiveFloatCents
        + aggregates.cashSalesCents
        - aggregates.cashRefundsByCreatedAtCents
        + aggregates.carteraCashInCents
        - aggregates.carteraCashOutCents;
      const varianceCents = countedCashCents - expectedCashCents;

      let zNumber: number;
      try {
        zNumber = nextZNumber();
      } catch (err: any) {
        throw httpError(`Could not allocate Z number: ${err?.message || 'sequence failure'}`, 500);
      }

      const createdAt = now();
      try {
        db.prepare(`
          INSERT INTO cash_closures (
            scope, business_date, period_start, period_end,
            opening_float_cents, expected_cash_cents, counted_cash_cents, variance_cents,
            gross_collected_cents, refunded_cents, net_collected_cents,
            bill_count, refund_count,
            payment_methods_json, staff_sales_json, tax_components_json,
            z_number, closed_by, notes, created_at
          ) VALUES (
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?
          )
        `).run(
          scope, businessDate,
          openSession ? String(openSession.opened_at) : periodStart,
          openSession ? closingAt : periodEnd,
          effectiveFloatCents, expectedCashCents, countedCashCents, varianceCents,
          aggregates.grossCollectedCents, aggregates.refundedCents, aggregates.netCollectedCents,
          aggregates.billCount, aggregates.refundCount,
          JSON.stringify(aggregates.paymentMethods),
          JSON.stringify(aggregates.staffSales),
          JSON.stringify(aggregates.taxComponents),
          zNumber, closedBy, notes, createdAt,
        );
      } catch (err: any) {
        // Race: another writer slipped through between the SELECT and this
        // INSERT — the partial index turns this into a clean 409.
        const msg = String(err?.message || '');
        if (msg.includes('UNIQUE') || msg.includes('cash_closures_one_day')) {
          throw httpError('This day is already closed', 409);
        }
        throw err;
      }

      const id = Number((db.prepare(
        `SELECT id FROM cash_closures WHERE z_number = ?`
      ).get(zNumber) as { id: number }).id);

      // La caja abierta queda cerrada y enlazada a su Z.
      if (openSession) {
        db.prepare(`UPDATE cash_sessions SET closed_at = ?, closure_id = ? WHERE id = ?`)
          .run(closingAt, id, openSession.id);
      }

      return {
        id,
        scope,
        business_date: businessDate,
        period_start: openSession ? String(openSession.opened_at) : periodStart,
        period_end: openSession ? closingAt : periodEnd,
        cash_session_id: openSession ? Number(openSession.id) : null,
        opening_float_cents: effectiveFloatCents,
        expected_cash_cents: expectedCashCents,
        counted_cash_cents: countedCashCents,
        variance_cents: varianceCents,
        gross_collected_cents: aggregates.grossCollectedCents,
        refunded_cents: aggregates.refundedCents,
        net_collected_cents: aggregates.netCollectedCents,
        bill_count: aggregates.billCount,
        refund_count: aggregates.refundCount,
        payment_methods: aggregates.paymentMethods,
        staff_sales: aggregates.staffSales,
        tax_components: aggregates.taxComponents,
        z_number: zNumber,
        closed_by: closedBy,
        notes,
        created_at: createdAt,
      };
    });

    res.status(201).json({ zReport: result });
  } catch (error: any) {
    const status = error.statusCode || 500;
    if (status === 500) console.error('[CashClosures] Internal error:', error);
    res.status(status).json({ error: status === 500 ? 'Internal server error' : error.message || 'Internal server error' });
  }
});

// ── PUT /:id — corregir un cierre ya emitido ────────────────────────────────
// Owner-only. Sólo se corrigen los importes que declara el operador (fondo,
// conteo) y las notas; lo que sale de las ventas (`expected_cash_cents`, los
// totales, el z_number) no se toca, porque falsearlo sería falsear la venta.
// La diferencia se recalcula, nunca se escribe a mano, y cada campo cambiado
// queda registrado en `cash_closure_amendments` con su motivo.
router.put('/:id', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw httpError('id must be a positive integer', 400);
    }
    const body = req.body || {};
    const amendedBy = String((req as any).user?.userId || '');
    if (!amendedBy) throw httpError('Authentication required', 401);

    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) throw httpError('reason is required to amend a closure', 400);
    if (reason.length > MAX_NOTES_LENGTH) throw httpError('reason is too long', 400);

    const existing = db.prepare('SELECT * FROM cash_closures WHERE id = ?').get(id) as any;
    if (!existing) throw httpError('Closure not found', 404);

    const openingFloatCents = body.opening_float_cents === undefined
      ? Number(existing.opening_float_cents)
      : validateCents(body.opening_float_cents, 'opening_float_cents');
    const countedCashCents = body.counted_cash_cents === undefined
      ? Number(existing.counted_cash_cents)
      : validateCents(body.counted_cash_cents, 'counted_cash_cents');
    if (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') {
      throw httpError('notes must be a string', 400);
    }
    if (typeof body.notes === 'string' && body.notes.length > MAX_NOTES_LENGTH) {
      throw httpError('notes is too long', 400);
    }
    const notes = body.notes === undefined ? existing.notes : (body.notes || null);

    // El esperado conserva las ventas de la instantánea; corregir el fondo lo
    // desplaza en la misma medida, que es justo lo que el operador está
    // declarando al enmendar.
    const salesComponentCents = Number(existing.expected_cash_cents) - Number(existing.opening_float_cents);
    const expectedCashCents = openingFloatCents + salesComponentCents;
    const varianceCents = countedCashCents - expectedCashCents;

    const changes: { field: string; oldValue: string; newValue: string }[] = [];
    const track = (field: string, before: unknown, after: unknown) => {
      const a = before === null || before === undefined ? '' : String(before);
      const b = after === null || after === undefined ? '' : String(after);
      if (a !== b) changes.push({ field, oldValue: a, newValue: b });
    };
    track('opening_float_cents', existing.opening_float_cents, openingFloatCents);
    track('counted_cash_cents', existing.counted_cash_cents, countedCashCents);
    track('expected_cash_cents', existing.expected_cash_cents, expectedCashCents);
    track('variance_cents', existing.variance_cents, varianceCents);
    track('notes', existing.notes, notes);

    if (changes.length === 0) throw httpError('Nothing to amend', 400);

    const updated = withTxn(() => {
      db.prepare(`
        UPDATE cash_closures
        SET opening_float_cents = ?, expected_cash_cents = ?, counted_cash_cents = ?,
            variance_cents = ?, notes = ?
        WHERE id = ?
      `).run(openingFloatCents, expectedCashCents, countedCashCents, varianceCents, notes, id);

      const insertAmendment = db.prepare(`
        INSERT INTO cash_closure_amendments (closure_id, field, old_value, new_value, reason, amended_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const stamp = now();
      for (const change of changes) {
        insertAmendment.run(id, change.field, change.oldValue, change.newValue, reason, amendedBy, stamp);
      }
      const row = db.prepare('SELECT * FROM cash_closures WHERE id = ?').get(id);
      // Misma forma que GET /reports/z-report: el ticket necesita los arreglos
      // de metodos de pago, ventas por personal e impuestos ya parseados.
      return shapeZReportSnapshot(db, row, false);
    });

    res.json({ closure: updated, amended_fields: changes.map((c) => c.field) });
  } catch (error: any) {
    const status = error.statusCode || 500;
    if (status === 500) console.error('[CashClosures] Internal error:', error);
    res.status(status).json({ error: status === 500 ? 'Internal server error' : error.message || 'Internal server error' });
  }
});

// ── GET / — historial de cierres ────────────────────────────────────────────
// Owner-only, paginado como el resto de listados (bills.ts). Cada fila trae
// quién cerró, si el Z fue corregido y la ventana del turno, que es lo que el
// propietario necesita para leer una caja sin abrir cada reporte.
router.get('/', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const parseInteger = (value: unknown, fallback: number): number | null => {
      if (value === undefined || value === null || value === '') return fallback;
      if (Array.isArray(value)) return null;
      const parsed = Number(value);
      return Number.isInteger(parsed) ? parsed : null;
    };

    const requestedLimit = parseInteger(req.query.per_page ?? req.query.limit, 30);
    if (requestedLimit === null || requestedLimit < 1) {
      throw httpError('per_page must be a positive integer', 400);
    }
    const limit = Math.min(requestedLimit, 200);
    const offset = parseInteger(req.query.offset, 0);
    if (offset === null || offset < 0) {
      throw httpError('offset must be a non-negative integer', 400);
    }

    const wheres: string[] = [];
    const params: any[] = [];
    if (typeof req.query.from === 'string' && ISO_DATE_RE.test(req.query.from)) {
      wheres.push('c.business_date >= ?');
      params.push(req.query.from);
    }
    if (typeof req.query.to === 'string' && ISO_DATE_RE.test(req.query.to)) {
      wheres.push('c.business_date <= ?');
      params.push(req.query.to);
    }
    const whereSql = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';

    const rows = db.prepare(`
      SELECT
        c.id, c.z_number, c.scope, c.business_date, c.period_start, c.period_end,
        c.opening_float_cents, c.expected_cash_cents, c.counted_cash_cents, c.variance_cents,
        c.gross_collected_cents, c.refunded_cents, c.net_collected_cents,
        c.bill_count, c.refund_count, c.notes, c.created_at,
        u.name AS closed_by_name,
        s.opened_at, s.opened_by AS opened_by_id, ou.name AS opened_by_name,
        (SELECT COUNT(*) FROM cash_closure_amendments a WHERE a.closure_id = c.id) AS amendment_count
      FROM cash_closures c
      LEFT JOIN users u ON u.id = c.closed_by
      LEFT JOIN cash_sessions s ON s.closure_id = c.id
      LEFT JOIN users ou ON ou.id = s.opened_by
      ${whereSql}
      ORDER BY c.z_number DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as any[];

    const total = Number((db.prepare(
      `SELECT COUNT(*) AS count FROM cash_closures c ${whereSql}`
    ).get(...params) as any)?.count || 0);

    res.json({
      closures: rows,
      pagination: {
        limit,
        per_page: limit,
        offset,
        total,
        next_offset: offset + rows.length < total ? offset + rows.length : null,
        has_more: offset + rows.length < total,
      },
    });
  } catch (error: any) {
    const status = error.statusCode || 500;
    if (status === 500) console.error('[CashClosures] Internal error:', error);
    res.status(status).json({ error: status === 500 ? 'Internal server error' : error.message });
  }
});

// ── GET /:id/amendments — historial de correcciones de un cierre ────────────
router.get('/:id/amendments', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw httpError('id must be a positive integer', 400);
    }
    const rows = db.prepare(`
      SELECT a.*, u.name AS amended_by_name
      FROM cash_closure_amendments a
      LEFT JOIN users u ON u.id = a.amended_by
      WHERE a.closure_id = ?
      ORDER BY a.id
    `).all(id);
    res.json({ amendments: rows });
  } catch (error: any) {
    const status = error.statusCode || 500;
    if (status === 500) console.error('[CashClosures] Internal error:', error);
    res.status(status).json({ error: status === 500 ? 'Internal server error' : error.message || 'Internal server error' });
  }
});

export { router as cashClosureRoutes };

// ── POST /:id/print — dispatch the stored Z to the default printer ──────────
// Owner-only. The forced drawer pulse is appended by `printZReport` itself
// (bypassing bill-bound `shouldPulseForPayment`, spec #649). WebUSB printers
// return `{ bytes: number[] }` for the frontend to dispatch; network/usb
// printers go through the backend socket. The Z row is never mutated.
router.post('/:id/print', requireRole(...ROLE_ACCESS.owner), async (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id must be a positive integer' });
    }
    const row = db.prepare(`SELECT * FROM cash_closures WHERE id = ?`).get(id) as any;
    if (!row) return res.status(404).json({ error: 'Cash closure not found' });
    const isReprint = req.body && req.body.isReprint === true;
    // F6: resolve the operator's display name via users(id → name) so the
    // printed Z shows the operator (not the raw user id). Falls back to the
    // id string when the user row is missing (e.g. historical data after a
    // staff deletion).
    const snapshot = shapeZReportSnapshot(db, row, isReprint);
    // Resolve the default receipt printer server-side so the WebUSB branch
    // is reachable end-to-end (mirrors `main/routes/printers.ts:304-339`,
    // bytes branch `:329-331`). `getPrinterConfig()` inside the helper
    // excludes webusb; selecting it here closes that gap.
    const printer = db.prepare(`SELECT * FROM printers WHERE is_default = 1`).get() as any;
    if (!printer) return res.status(409).json({ error: 'No default printer configured' });
    const { printZReport } = require('../printers/thermal');
    // F7: thread request signal through so a server shutdown aborts the
    // print job (pattern at `main/routes/printers.ts:119,323`). No language
    // argument: the Z body is built with English literals by design, and
    // shaping/code-page selection comes from the printer-profile
    // capabilities, not from a language bundle.
    const result = await printZReport(snapshot, getHttpRequestSignal(req), printer);
    if (printer.connection_type === 'webusb' && result?.bytes) {
      // Return the FULL bytes including the forced drawer pulse; the renderer
      // dispatches them over WebUSB exactly as the test-page endpoint does.
      return res.json({ success: true, webusb: true, isReprint, bytes: Array.from(result.bytes) });
    }
    if (!result.ok) {
      return res.status(502).json({ error: result.detail || 'Printer did not respond or print failed', detail: result.detail });
    }
    res.json({ success: true, isReprint });
  } catch (error: any) {
    console.error('[CashClosures] Print error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
