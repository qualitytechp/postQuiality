/**
 * Purchases: what the business buys from its suppliers.
 *
 * Two things happen when a purchase is received, and both go through paths that
 * already exist rather than new ones of their own:
 *
 *   · Stock goes up through `applyStockMovement`, so the entry is explained in
 *     the ledger like every other change.
 *   · `products.cost` is re-averaged. That column has existed since the start
 *     and until now only the CSV import and export ever read it; purchases give
 *     it its first real source.
 *
 * Voiding never subtracts blindly. It writes a compensating movement for what
 * each line actually added, so a purchase can be voided after some of the goods
 * were already sold: the balance may go negative, but it stays explained.
 */
import type Database from 'better-sqlite3';
import { generatePurchaseNumber, getSettingValue, localDateInTimezone, now } from '../db';
import { getCurrencyMinorUnitFactor } from '../countries';
import { applyStockMovement } from './inventory';
import { cashAccount, cashOnHandCents, getAccount, listAccounts, openCashSession, type CarteraAccount } from './cartera';

export interface PurchaseLineInput {
  product_id?: string | null;
  description?: string | null;
  quantity: number;
  unit_cost_cents: number;
}

export interface CreatePurchaseInput {
  supplier_id: string;
  invoice_ref?: string | null;
  notes?: string | null;
  payment_terms: 'cash' | 'credit';
  due_date?: string | null;
  tax_cents?: number;
  items: PurchaseLineInput[];
  /** Method name for the settling payment; only meaningful on a cash purchase. */
  payment_method?: string | null;
  /** Treasury account the money leaves from; falls back to the drawer. */
  account_id?: number | null;
  userId: string;
}

export class PurchaseError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LINES = 200;

function tenantTimezone(): string {
  return getSettingValue('timezone') || 'Asia/Kolkata';
}

function minorFactor(): number {
  return getCurrencyMinorUnitFactor(getSettingValue('currency') || 'INR');
}

function roundCents(value: number): number {
  return Math.round(value);
}

/**
 * Which account the money leaves. An explicit account wins; otherwise the
 * method name is matched against the accounts, and cash falls back to the
 * drawer. Returns undefined when Cartera is not set up at all, which simply
 * means the payment is recorded without a treasury account — the purchase
 * itself still stands.
 */
function resolvePaymentAccount(
  db: Database.Database,
  accountId: number | null,
  method: string | null,
): CarteraAccount | undefined {
  if (accountId) {
    const account = getAccount(db, accountId);
    if (!account) throw new PurchaseError('Account not found', 404);
    if (!account.is_active) throw new PurchaseError('Account is inactive');
    return account;
  }
  if (!method || method === 'cash') return cashAccount(db);
  const accounts = listAccounts(db, true);
  return accounts.find((a) => a.name.toLowerCase() === method.toLowerCase())
    ?? accounts.find((a) => a.canonical_method === method);
}

/**
 * Weighted average, which is what a merchant means by "what does it cost me".
 * With nothing on hand there is nothing to average against, so the purchase
 * price simply becomes the cost — the alternative would divide by zero or,
 * worse, keep a stale figure from stock that is long gone.
 */
export function weightedAverageCost(
  onHand: number,
  currentCost: number,
  incomingQuantity: number,
  incomingCost: number,
): number {
  if (!(incomingQuantity > 0)) return currentCost;
  if (!(onHand > 0)) return incomingCost;
  const total = onHand + incomingQuantity;
  if (!(total > 0)) return incomingCost;
  return (onHand * currentCost + incomingQuantity * incomingCost) / total;
}

export function createPurchase(db: Database.Database, input: CreatePurchaseInput) {
  const supplier = db.prepare('SELECT id, is_active FROM suppliers WHERE id = ?').get(input.supplier_id) as
    { id: string; is_active: number } | undefined;
  if (!supplier) throw new PurchaseError('Supplier not found', 404);
  if (!supplier.is_active) throw new PurchaseError('Supplier is inactive');

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new PurchaseError('A purchase needs at least one line');
  }
  if (input.items.length > MAX_LINES) {
    throw new PurchaseError(`A purchase cannot have more than ${MAX_LINES} lines`);
  }
  if (input.payment_terms === 'credit' && (!input.due_date || !ISO_DATE.test(input.due_date))) {
    throw new PurchaseError('A credit purchase needs a due date');
  }

  const taxCents = roundCents(Number(input.tax_cents) || 0);
  if (taxCents < 0) throw new PurchaseError('Tax cannot be negative');

  // Resolve every line before writing anything, so a bad line at the end does
  // not leave half a purchase behind.
  const resolved = input.items.map((item, index) => {
    const quantity = Number(item.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new PurchaseError(`Line ${index + 1}: quantity must be greater than zero`);
    }
    const unitCostCents = Number(item.unit_cost_cents);
    if (!Number.isInteger(unitCostCents) || unitCostCents < 0) {
      throw new PurchaseError(`Line ${index + 1}: unit cost must be a whole number of cents, zero or more`);
    }

    let product: { id: string; name: string; sale_unit: string; track_inventory: number; stock_quantity: number; cost: number } | undefined;
    if (item.product_id) {
      product = db.prepare(
        'SELECT id, name, sale_unit, track_inventory, stock_quantity, cost FROM products WHERE id = ? AND deleted_at IS NULL',
      ).get(item.product_id) as any;
      if (!product) throw new PurchaseError(`Line ${index + 1}: product not found`, 404);
    }

    const description = (item.description || product?.name || '').trim();
    if (!description) throw new PurchaseError(`Line ${index + 1}: a line without a product needs a description`);

    return {
      product,
      description,
      quantity,
      // The line inherits the product's own unit, so a fruver buying by the
      // kilo and a restaurant buying by the unit use the same table.
      unit: product?.sale_unit || 'each',
      unitCostCents,
      lineTotalCents: roundCents(quantity * unitCostCents),
    };
  });

  const subtotalCents = resolved.reduce((sum, line) => sum + line.lineTotalCents, 0);
  const totalCents = subtotalCents + taxCents;

  const timestamp = now();
  const businessDate = localDateInTimezone(new Date(), tenantTimezone());
  const purchaseNumber = generatePurchaseNumber();

  const purchaseId = db.prepare(`
    INSERT INTO purchases
      (purchase_number, supplier_id, invoice_ref, subtotal_cents, tax_cents, total_cents,
       payment_terms, due_date, status, notes, received_at, business_date, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, ?, ?)
  `).run(
    purchaseNumber, input.supplier_id, input.invoice_ref || null,
    subtotalCents, taxCents, totalCents,
    input.payment_terms, input.payment_terms === 'credit' ? input.due_date : null,
    input.notes || null, timestamp, businessDate, input.userId, timestamp,
  ).lastInsertRowid;

  const insertItem = db.prepare(`
    INSERT INTO purchase_items
      (purchase_id, product_id, description, quantity, unit, unit_cost_cents, line_total_cents, inventory_added_quantity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const factor = minorFactor();

  for (const line of resolved) {
    const tracks = !!line.product?.track_inventory;
    const itemId = insertItem.run(
      purchaseId, line.product?.id ?? null, line.description, line.quantity,
      line.unit, line.unitCostCents, line.lineTotalCents,
      tracks ? line.quantity : 0,
    ).lastInsertRowid;

    if (line.product) {
      if (tracks) {
        applyStockMovement(db, {
          productId: line.product.id,
          delta: line.quantity,
          reason: 'purchase',
          refType: 'purchase_item',
          refId: itemId,
          userId: input.userId,
        });
      }
      // Cost is re-averaged whether or not the product tracks stock; with no
      // stock to weigh against, the purchase price becomes the cost.
      const nextCost = weightedAverageCost(
        tracks ? Number(line.product.stock_quantity) || 0 : 0,
        Number(line.product.cost) || 0,
        line.quantity,
        line.unitCostCents / factor,
      );
      db.prepare('UPDATE products SET cost = ?, updated_at = ? WHERE id = ?')
        .run(nextCost, now(), line.product.id);
    }
  }

  if (input.payment_terms === 'cash' && totalCents > 0) {
    // Which account the money left matters: it is what lets the treasury
    // balance drop and, for the drawer, what ties the outflow to the open
    // register so the Z report can account for it. Paying cash with the
    // register closed is refused for exactly that reason.
    const account = resolvePaymentAccount(db, input.account_id ?? null, input.payment_method ?? null);
    let sessionId: number | null = null;
    if (account?.kind === 'cash') {
      const session = openCashSession(db);
      if (!session) throw new PurchaseError('Open the register before paying with cash', 409);
      if (totalCents > cashOnHandCents(db)) {
        throw new PurchaseError('The register holds less than that', 409);
      }
      sessionId = session.id;
    }
    db.prepare(`
      INSERT INTO purchase_payments
        (purchase_id, amount_cents, method, paid_at, business_date, cash_session_id, account_id, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      purchaseId, totalCents, account?.canonical_method || input.payment_method || 'cash',
      timestamp, businessDate, sessionId, account?.id ?? null, input.userId, timestamp,
    );
  }

  return { id: Number(purchaseId), purchase_number: purchaseNumber, total_cents: totalCents };
}

export function voidPurchase(db: Database.Database, purchaseId: number, reason: string, userId: string) {
  const purchase = db.prepare('SELECT id, status FROM purchases WHERE id = ?').get(purchaseId) as
    { id: number; status: string } | undefined;
  if (!purchase) throw new PurchaseError('Purchase not found', 404);
  if (purchase.status === 'void') throw new PurchaseError('Purchase is already void', 409);
  if (!reason || !String(reason).trim()) throw new PurchaseError('Voiding a purchase needs a reason');

  const items = db.prepare(
    'SELECT id, product_id, inventory_added_quantity FROM purchase_items WHERE purchase_id = ?',
  ).all(purchaseId) as { id: number; product_id: string | null; inventory_added_quantity: number }[];

  for (const item of items) {
    if (!item.product_id || !(item.inventory_added_quantity > 0)) continue;
    // Reverses what this line actually added, not what was typed, and is
    // allowed to go below zero: the goods may already be sold, and refusing
    // would leave the ledger disagreeing with what happened.
    applyStockMovement(db, {
      productId: item.product_id,
      delta: -item.inventory_added_quantity,
      reason: 'purchase_void',
      refType: 'purchase_item',
      refId: item.id,
      userId,
      allowNegative: true,
    });
  }

  const timestamp = now();
  db.prepare(`
    UPDATE purchases SET status = 'void', voided_at = ?, voided_by = ?, void_reason = ?
    WHERE id = ?
  `).run(timestamp, userId, String(reason).trim(), purchaseId);

  // Cost is deliberately left alone. Re-deriving an average backwards from a
  // reversal would need the whole purchase history per product; the next
  // purchase corrects it, and a wrong cost is a reporting figure, not money.
  return { id: purchaseId, status: 'void' as const };
}

/** Outstanding balance per purchase: total less what has been paid so far. */
export function purchaseBalanceCents(db: Database.Database, purchaseId: number): number {
  const row = db.prepare(`
    SELECT p.total_cents - COALESCE((
      SELECT SUM(amount_cents) FROM purchase_payments WHERE purchase_id = p.id
    ), 0) AS balance_cents
    FROM purchases p WHERE p.id = ?
  `).get(purchaseId) as { balance_cents: number } | undefined;
  return row ? Number(row.balance_cents) : 0;
}
