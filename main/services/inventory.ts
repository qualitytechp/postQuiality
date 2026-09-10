/**
 * The one path that changes stock.
 *
 * Before this, eight places updated `products.stock_quantity` directly and none
 * of them left a trace, so the running total could not be explained or checked.
 * Every one of them now goes through `applyStockMovement`, which writes the
 * column and the ledger row together inside the caller's transaction.
 *
 * The column stays the authoritative balance — nothing that already worked
 * changes shape. `stock_movements.balance_after` records what the balance
 * became, so the ledger and the column can be reconciled on a real database.
 */
import type Database from 'better-sqlite3';
import { getSettingValue, localDateInTimezone, now } from '../db';

export type StockReason =
  | 'sale'
  | 'sale_cancel'
  | 'sale_restore'
  | 'purchase'
  | 'purchase_void'
  | 'adjustment';

export interface StockMovementInput {
  productId: string;
  /** Positive adds, negative removes. Zero touches the product and logs nothing. */
  delta: number;
  reason: StockReason;
  refType?: string | null;
  refId?: string | number | bigint | null;
  note?: string | null;
  /** Null for movements the system makes on its own. */
  userId?: string | null;
  /**
   * Off by default, so a removal that would overdraw is refused rather than
   * silently pushing the balance below zero. Corrections that reverse an
   * earlier movement pass true: the stock may genuinely be gone already, and
   * refusing would leave the ledger disagreeing with what actually happened.
   */
  allowNegative?: boolean;
}

export type StockApplyResult =
  | { ok: true; balanceAfter: number }
  | { ok: false; reason: 'not_found' | 'insufficient' };

function businessDate(): string {
  return localDateInTimezone(new Date(), getSettingValue('timezone') || 'Asia/Kolkata');
}

export function applyStockMovement(db: Database.Database, input: StockMovementInput): StockApplyResult {
  const product = db
    .prepare('SELECT stock_quantity FROM products WHERE id = ? AND deleted_at IS NULL')
    .get(input.productId) as { stock_quantity: number } | undefined;
  if (!product) return { ok: false, reason: 'not_found' };

  const current = Number(product.stock_quantity) || 0;
  const balanceAfter = current + input.delta;
  if (!input.allowNegative && balanceAfter < 0) {
    return { ok: false, reason: 'insufficient' };
  }

  const timestamp = now();
  db.prepare('UPDATE products SET stock_quantity = ?, updated_at = ? WHERE id = ?')
    .run(balanceAfter, timestamp, input.productId);

  // `delta <> 0` is a table constraint: a no-op adjustment is not an event.
  if (input.delta !== 0) {
    db.prepare(`
      INSERT INTO stock_movements
        (product_id, delta, balance_after, reason, ref_type, ref_id, note, occurred_at, business_date, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.productId,
      input.delta,
      balanceAfter,
      input.reason,
      input.refType ?? null,
      input.refId === undefined || input.refId === null ? null : String(input.refId),
      input.note ?? null,
      timestamp,
      businessDate(),
      input.userId ?? null,
      timestamp,
    );
  }

  return { ok: true, balanceAfter };
}

/**
 * Reconciles the ledger against the cached column. Used by the stock tests and
 * available for diagnostics; a mismatch means some writer bypassed this module.
 */
export function findStockLedgerMismatches(db: Database.Database): {
  product_id: string;
  stock_quantity: number;
  balance_after: number;
}[] {
  return db.prepare(`
    SELECT p.id AS product_id, p.stock_quantity, m.balance_after
    FROM products p
    JOIN stock_movements m ON m.id = (
      SELECT id FROM stock_movements WHERE product_id = p.id ORDER BY id DESC LIMIT 1
    )
    WHERE ABS(p.stock_quantity - m.balance_after) > 0.0001
  `).all() as { product_id: string; stock_quantity: number; balance_after: number }[];
}
