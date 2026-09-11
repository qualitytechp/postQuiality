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

interface ResolvedLine {
  product?: { id: string; name: string; sale_unit: string; track_inventory: number; stock_quantity: number; cost: number };
  description: string;
  quantity: number;
  unit: string;
  unitCostCents: number;
  lineTotalCents: number;
}

/**
 * Validates and resolves every line before anything is written, so a bad line
 * at the end does not leave half a purchase behind. Shared by recording and
 * correcting, so both reject the same things for the same reasons.
 */
function resolveLines(db: Database.Database, items: PurchaseLineInput[]): ResolvedLine[] {
  return items.map((item, index) => {
    const quantity = Number(item.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new PurchaseError(`Line ${index + 1}: quantity must be greater than zero`);
    }
    const unitCostCents = Number(item.unit_cost_cents);
    if (!Number.isInteger(unitCostCents) || unitCostCents < 0) {
      throw new PurchaseError(`Line ${index + 1}: unit cost must be a whole number of cents, zero or more`);
    }

    let product: ResolvedLine['product'];
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

  const resolved = resolveLines(db, input.items);
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

export interface UpdatePurchaseInput {
  supplier_id?: string | null;
  invoice_ref?: string | null;
  notes?: string | null;
  payment_terms?: 'cash' | 'credit';
  due_date?: string | null;
  tax_cents?: number | null;
  items?: PurchaseLineInput[] | null;
  reason?: string | null;
  userId: string;
}

/**
 * Corrects a purchase that was already recorded.
 *
 * The hard part is not the form, it is that the purchase already did things:
 * stock went up and the product cost was re-averaged. So an edit is not a
 * silent overwrite —
 *
 *   · Stock is corrected by the exact difference, through the ledger, so the
 *     books show a correction rather than a number that quietly changed.
 *   · Cost is re-averaged forward when more goods arrive, and left alone when
 *     the correction reduces them — the same limit voiding has, and for the
 *     same reason: undoing an average needs the whole purchase history.
 *   · Every changed field is written to `purchase_amendments`.
 *   · The total may never drop below what has already been paid; that would
 *     mean the supplier was overpaid on a document that no longer says so.
 */
export function updatePurchase(db: Database.Database, purchaseId: number, input: UpdatePurchaseInput) {
  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchaseId) as any;
  if (!purchase) throw new PurchaseError('Purchase not found', 404);
  if (purchase.status === 'void') throw new PurchaseError('A void purchase cannot be edited', 409);

  const paidCents = Number((db.prepare(
    'SELECT COALESCE(SUM(amount_cents), 0) AS n FROM purchase_payments WHERE purchase_id = ?',
  ).get(purchaseId) as { n: number }).n);

  const amendments: { field: string; oldValue: unknown; newValue: unknown }[] = [];
  const record = (field: string, oldValue: unknown, newValue: unknown) => {
    if (String(oldValue ?? '') !== String(newValue ?? '')) amendments.push({ field, oldValue, newValue });
  };

  // ── Supplier ───────────────────────────────────────────────────────────
  let supplierId = purchase.supplier_id;
  if (input.supplier_id !== undefined && input.supplier_id !== null && input.supplier_id !== purchase.supplier_id) {
    if (paidCents > 0) {
      throw new PurchaseError('This purchase already has payments; the supplier can no longer be changed', 409);
    }
    const supplier = db.prepare('SELECT id, is_active FROM suppliers WHERE id = ?').get(input.supplier_id) as
      { id: string; is_active: number } | undefined;
    if (!supplier) throw new PurchaseError('Supplier not found', 404);
    if (!supplier.is_active) throw new PurchaseError('Supplier is inactive');
    record('supplier_id', purchase.supplier_id, input.supplier_id);
    supplierId = input.supplier_id;
  }

  // ── Terms ──────────────────────────────────────────────────────────────
  const terms = input.payment_terms ?? purchase.payment_terms;
  let dueDate = input.due_date === undefined ? purchase.due_date : input.due_date;
  if (terms === 'credit') {
    if (!dueDate || !ISO_DATE.test(String(dueDate))) throw new PurchaseError('A credit purchase needs a due date');
  } else {
    dueDate = null;
  }
  record('payment_terms', purchase.payment_terms, terms);
  record('due_date', purchase.due_date, dueDate);
  if (input.invoice_ref !== undefined) record('invoice_ref', purchase.invoice_ref, input.invoice_ref);
  if (input.notes !== undefined) record('notes', purchase.notes, input.notes);

  const invoiceRef = input.invoice_ref === undefined ? purchase.invoice_ref : input.invoice_ref;
  const notes = input.notes === undefined ? purchase.notes : input.notes;

  // ── Lines ──────────────────────────────────────────────────────────────
  let subtotalCents = Number(purchase.subtotal_cents);
  let taxCents = input.tax_cents === undefined || input.tax_cents === null
    ? Number(purchase.tax_cents)
    : roundCents(Number(input.tax_cents));
  if (taxCents < 0) throw new PurchaseError('Tax cannot be negative');
  record('tax_cents', purchase.tax_cents, taxCents);

  if (input.items) {
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new PurchaseError('A purchase needs at least one line');
    }
    if (input.items.length > MAX_LINES) {
      throw new PurchaseError(`A purchase cannot have more than ${MAX_LINES} lines`);
    }

    const oldItems = db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ?').all(purchaseId) as any[];
    const resolved = resolveLines(db, input.items);
    subtotalCents = resolved.reduce((sum, line) => sum + line.lineTotalCents, 0);

    // What each product gained or lost by this correction, netted so a line
    // that merely moved position does not produce two pointless movements.
    const delta = new Map<string, number>();
    for (const item of oldItems) {
      if (!item.product_id || !(item.inventory_added_quantity > 0)) continue;
      delta.set(item.product_id, (delta.get(item.product_id) || 0) - Number(item.inventory_added_quantity));
    }

    db.prepare('DELETE FROM purchase_items WHERE purchase_id = ?').run(purchaseId);
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
        line.unit, line.unitCostCents, line.lineTotalCents, tracks ? line.quantity : 0,
      ).lastInsertRowid;

      if (line.product && tracks) {
        delta.set(line.product.id, (delta.get(line.product.id) || 0) + line.quantity);
      }
      // Cost is only re-averaged when the correction brings more goods in.
      // Reducing a quantity cannot un-average what the original purchase did,
      // so the figure is left for the next purchase to correct.
      if (line.product) {
        const net = delta.get(line.product.id) ?? 0;
        if (net > 0) {
          const current = db.prepare('SELECT stock_quantity, cost FROM products WHERE id = ?')
            .get(line.product.id) as { stock_quantity: number; cost: number };
          const nextCost = weightedAverageCost(
            Math.max(0, Number(current.stock_quantity) || 0),
            Number(current.cost) || 0,
            net,
            line.unitCostCents / factor,
          );
          db.prepare('UPDATE products SET cost = ?, updated_at = ? WHERE id = ?')
            .run(nextCost, now(), line.product.id);
        }
      }
      void itemId;
    }

    for (const [productId, amount] of delta) {
      if (Math.abs(amount) < 1e-9) continue;
      applyStockMovement(db, {
        productId,
        delta: amount,
        reason: amount > 0 ? 'purchase' : 'purchase_void',
        refType: 'purchase_item',
        refId: purchaseId,
        note: 'corrección de la compra',
        userId: input.userId,
        // A correction that reduces what arrived may take stock below zero if
        // it was already sold. That is the truth of what happened, and the
        // ledger says so rather than hiding it.
        allowNegative: amount < 0,
      });
    }

    record('subtotal_cents', purchase.subtotal_cents, subtotalCents);
  }

  const totalCents = subtotalCents + taxCents;
  if (totalCents < paidCents) {
    throw new PurchaseError('The new total is below what has already been paid to the supplier', 409);
  }
  record('total_cents', purchase.total_cents, totalCents);

  db.prepare(`
    UPDATE purchases SET
      supplier_id = ?, invoice_ref = ?, notes = ?, payment_terms = ?, due_date = ?,
      subtotal_cents = ?, tax_cents = ?, total_cents = ?
    WHERE id = ?
  `).run(supplierId, invoiceRef, notes, terms, dueDate, subtotalCents, taxCents, totalCents, purchaseId);

  const timestamp = now();
  const insertAmendment = db.prepare(`
    INSERT INTO purchase_amendments (purchase_id, field, old_value, new_value, reason, amended_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const change of amendments) {
    insertAmendment.run(
      purchaseId, change.field,
      change.oldValue === null || change.oldValue === undefined ? null : String(change.oldValue),
      change.newValue === null || change.newValue === undefined ? null : String(change.newValue),
      input.reason?.trim().slice(0, 300) || null, input.userId, timestamp,
    );
  }

  return { id: purchaseId, total_cents: totalCents, changed: amendments.map((a) => a.field) };
}

/**
 * Pays a purchase, in full or in part. An abono is the ordinary case: a
 * merchant hands over what they have now and settles the rest later, and the
 * balance is always total less what has been handed over — never a stored
 * figure that could disagree.
 */
export function payPurchase(db: Database.Database, input: {
  purchaseId: number;
  amountCents?: number | null;
  method?: string | null;
  accountId?: number | null;
  userId: string;
}): { paid_cents: number; balance_cents: number; settled: boolean } {
  const purchase = db.prepare('SELECT id, total_cents, status FROM purchases WHERE id = ?')
    .get(input.purchaseId) as { id: number; total_cents: number; status: string } | undefined;
  if (!purchase) throw new PurchaseError('Purchase not found', 404);
  if (purchase.status === 'void') throw new PurchaseError('Purchase is void', 409);

  const paidCents = Number((db.prepare(
    'SELECT COALESCE(SUM(amount_cents), 0) AS n FROM purchase_payments WHERE purchase_id = ?',
  ).get(input.purchaseId) as { n: number }).n);
  const remaining = Number(purchase.total_cents) - paidCents;
  if (remaining <= 0) throw new PurchaseError('This purchase is already paid in full', 409);

  // No amount means settle the rest, which is what tapping Pay on a balance
  // without typing anything means.
  const amount = input.amountCents === undefined || input.amountCents === null ? remaining : input.amountCents;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new PurchaseError('Amount must be a whole number of cents, greater than zero');
  }
  if (amount > remaining) throw new PurchaseError('Payment is larger than the outstanding balance');

  const account = resolvePaymentAccount(db, input.accountId ?? null, input.method ?? null);
  const method = account?.canonical_method || account?.name || input.method || 'cash';

  let sessionId: number | null = null;
  if (method === 'cash') {
    const session = openCashSession(db);
    if (!session) throw new PurchaseError('Open the register before paying with cash', 409);
    if (amount > cashOnHandCents(db)) throw new PurchaseError('The register holds less than that', 409);
    sessionId = session.id;
  }

  const timestamp = now();
  db.prepare(`
    INSERT INTO purchase_payments
      (purchase_id, amount_cents, method, paid_at, business_date, cash_session_id, account_id, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.purchaseId, amount, method, timestamp,
    localDateInTimezone(new Date(), tenantTimezone()), sessionId, account?.id ?? null,
    input.userId, timestamp,
  );

  return { paid_cents: paidCents + amount, balance_cents: remaining - amount, settled: remaining - amount === 0 };
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
