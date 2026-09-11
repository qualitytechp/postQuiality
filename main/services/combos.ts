/**
 * Combos, kits and baskets: one product that, when sold, takes several out of
 * stock. A fruver's "canasta verde" and a restaurant's "combo fiesta" are the
 * same fact — you charge for one thing and hand over several.
 *
 * The combo is an ordinary product with its own price, so the POS shows it as
 * one more item and the cashier learns nothing new. What is different happens
 * behind the till: the sale deducts the components instead of the combo, and
 * what came out is recorded per line so a cancellation gives back exactly what
 * was taken — even if the recipe changed in the meantime.
 */
import type Database from 'better-sqlite3';
import { applyStockMovement } from './inventory';

export interface ComponentRow {
  component_product_id: string;
  quantity: number;
  name: string;
  sale_unit: string;
  track_inventory: number;
  stock_quantity: number;
  cost: number;
  is_combo: number;
}

export class ComboError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** The components of a product, empty for an ordinary one. */
export function componentsOf(db: Database.Database, productId: string): ComponentRow[] {
  return db.prepare(`
    SELECT pc.component_product_id, pc.quantity,
           p.name, p.sale_unit, p.track_inventory, p.stock_quantity, p.cost,
           EXISTS (SELECT 1 FROM product_components WHERE parent_product_id = p.id) AS is_combo
    FROM product_components pc
    JOIN products p ON p.id = pc.component_product_id
    WHERE pc.parent_product_id = ?
    ORDER BY pc.sort_order, pc.id
  `).all(productId) as ComponentRow[];
}

export function isCombo(db: Database.Database, productId: string): boolean {
  const row = db.prepare('SELECT 1 AS n FROM product_components WHERE parent_product_id = ? LIMIT 1').get(productId);
  return !!row;
}

/**
 * How many of this combo the components allow. A combo has no stock of its own
 * — what it has is whatever its scarcest part allows, which is the number a
 * merchant actually wants to see on the screen.
 *
 * Components that do not track stock place no limit: nobody counts the sachets
 * of salt.
 */
export function availableUnits(db: Database.Database, productId: string): number | null {
  const components = componentsOf(db, productId);
  if (components.length === 0) return null;
  const limited = components.filter((component) => component.track_inventory);
  if (limited.length === 0) return null;
  return limited.reduce((fewest, component) => {
    const possible = Math.floor((Number(component.stock_quantity) || 0) / Number(component.quantity));
    return Math.min(fewest, Math.max(0, possible));
  }, Number.POSITIVE_INFINITY);
}

/** What the combo costs the business: the sum of what its parts cost. */
export function comboCost(db: Database.Database, productId: string): number {
  return componentsOf(db, productId)
    .reduce((sum, component) => sum + (Number(component.cost) || 0) * Number(component.quantity), 0);
}

/**
 * Checks a combo can be sold `quantity` times before anything is written.
 * Refusing here rather than mid-sale is what keeps an order from being left
 * half-recorded with stock already taken.
 */
export function assertComponentsAvailable(db: Database.Database, productId: string, quantity: number): void {
  for (const component of componentsOf(db, productId)) {
    if (!component.track_inventory) continue;
    const needed = Number(component.quantity) * quantity;
    if (Number(component.stock_quantity) < needed) {
      throw new ComboError(`Insufficient stock for ${component.name}`);
    }
  }
}

/**
 * Takes the components out of stock for one sold line and records what came
 * out. Returns what was deducted so the caller can report it.
 */
export function deductComponents(db: Database.Database, input: {
  orderItemId: number | bigint;
  productId: string;
  quantity: number;
  userId?: string | null;
}): { product_id: string; quantity: number }[] {
  const components = componentsOf(db, input.productId);
  if (components.length === 0) return [];

  const insert = db.prepare(`
    INSERT INTO order_item_components (order_item_id, product_id, quantity)
    VALUES (?, ?, ?)
  `);
  const taken: { product_id: string; quantity: number }[] = [];

  for (const component of components) {
    const amount = Number(component.quantity) * input.quantity;
    if (!(amount > 0)) continue;
    // Recorded even when the component does not track stock: it is still part
    // of what was handed over, and the kitchen ticket reads this list.
    insert.run(input.orderItemId, component.component_product_id, amount);
    taken.push({ product_id: component.component_product_id, quantity: amount });

    if (!component.track_inventory) continue;
    applyStockMovement(db, {
      productId: component.component_product_id,
      delta: -amount,
      reason: 'sale',
      refType: 'order_item',
      refId: input.orderItemId,
      note: 'combo',
      userId: input.userId ?? null,
      // The availability check above already decided whether the sale goes
      // through; this only applies it, exactly as an ordinary sale does.
      allowNegative: true,
    });
  }
  return taken;
}

/** Gives back what a cancelled line took, from the record of what it took. */
export function restoreComponents(db: Database.Database, orderItemId: number, userId?: string | null): void {
  const taken = db.prepare(
    'SELECT product_id, quantity FROM order_item_components WHERE order_item_id = ?',
  ).all(orderItemId) as { product_id: string; quantity: number }[];

  for (const row of taken) {
    const product = db.prepare('SELECT track_inventory FROM products WHERE id = ?')
      .get(row.product_id) as { track_inventory: number } | undefined;
    if (!product?.track_inventory) continue;
    applyStockMovement(db, {
      productId: row.product_id,
      delta: Number(row.quantity),
      reason: 'sale_cancel',
      refType: 'order_item',
      refId: orderItemId,
      note: 'combo',
      userId: userId ?? null,
      allowNegative: true,
    });
  }
}

/** Takes the components out again when a cancelled line is restored. */
export function redeductComponents(db: Database.Database, orderItemId: number, userId?: string | null): void {
  const taken = db.prepare(
    'SELECT product_id, quantity FROM order_item_components WHERE order_item_id = ?',
  ).all(orderItemId) as { product_id: string; quantity: number }[];

  for (const row of taken) {
    const product = db.prepare('SELECT track_inventory, stock_quantity, name FROM products WHERE id = ?')
      .get(row.product_id) as { track_inventory: number; stock_quantity: number; name: string } | undefined;
    if (!product?.track_inventory) continue;
    if (Number(product.stock_quantity) < Number(row.quantity)) {
      throw new ComboError(
        `Insufficient stock to restore item (${product.name}: ${product.stock_quantity} available, ${row.quantity} required)`,
      );
    }
    applyStockMovement(db, {
      productId: row.product_id,
      delta: -Number(row.quantity),
      reason: 'sale_restore',
      refType: 'order_item',
      refId: orderItemId,
      note: 'combo',
      userId: userId ?? null,
      allowNegative: true,
    });
  }
}

const MAX_COMPONENTS = 40;

/**
 * Replaces a product's component list.
 *
 * A combo may not contain another combo. Nesting would need cycle detection
 * and a recursive explosion at sale time, and no merchant has asked for a
 * basket inside a basket — the cost of allowing it is far above its use.
 */
export function setComponents(db: Database.Database, parentId: string, components: {
  product_id: string; quantity: number;
}[]): void {
  const parent = db.prepare('SELECT id FROM products WHERE id = ? AND deleted_at IS NULL').get(parentId);
  if (!parent) throw new ComboError('Product not found', 404);

  if (!Array.isArray(components)) throw new ComboError('components must be a list');
  if (components.length > MAX_COMPONENTS) {
    throw new ComboError(`A combo cannot have more than ${MAX_COMPONENTS} components`);
  }

  const usedAsComponentOf = db.prepare(
    'SELECT parent_product_id FROM product_components WHERE component_product_id = ? LIMIT 1',
  ).get(parentId) as { parent_product_id: string } | undefined;
  if (components.length > 0 && usedAsComponentOf) {
    throw new ComboError('This product is already part of another combo, so it cannot be a combo itself', 409);
  }

  const seen = new Set<string>();
  const resolved = components.map((component, index) => {
    const quantity = Number(component.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new ComboError(`Component ${index + 1}: quantity must be greater than zero`);
    }
    if (component.product_id === parentId) {
      throw new ComboError('A combo cannot contain itself');
    }
    if (seen.has(component.product_id)) {
      throw new ComboError('A component appears twice; use a larger quantity instead');
    }
    seen.add(component.product_id);

    const product = db.prepare('SELECT id FROM products WHERE id = ? AND deleted_at IS NULL').get(component.product_id);
    if (!product) throw new ComboError(`Component ${index + 1}: product not found`, 404);
    if (isCombo(db, component.product_id)) {
      throw new ComboError('A combo cannot contain another combo');
    }
    return { productId: component.product_id, quantity };
  });

  db.prepare('DELETE FROM product_components WHERE parent_product_id = ?').run(parentId);
  const insert = db.prepare(`
    INSERT INTO product_components (parent_product_id, component_product_id, quantity, sort_order)
    VALUES (?, ?, ?, ?)
  `);
  resolved.forEach((component, index) => {
    insert.run(parentId, component.productId, component.quantity, index * 10);
  });

  // A combo keeps no stock of its own: what it has is whatever its parts
  // allow. Leaving the flag on would show a second, always-wrong number.
  if (resolved.length > 0) {
    db.prepare('UPDATE products SET track_inventory = 0, stock_quantity = 0 WHERE id = ?').run(parentId);
  }
}
