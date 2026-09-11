/**
 * Purchases — correcting one that was already recorded
 *
 * Editing a purchase is not editing a form: the purchase already raised stock
 * and re-averaged the product cost. What is checked here:
 *
 *   · Metadata edits (invoice, due date, notes) change nothing but themselves.
 *   · Raising a quantity adds the difference to stock, never the whole amount
 *     again; lowering it takes back exactly the difference.
 *   · Removing a line takes its goods back out; adding one brings them in.
 *   · A correction that reduces goods already sold may take stock negative —
 *     that is the truth, and the ledger records it rather than hiding it.
 *   · The total can never fall below what was already paid to the supplier.
 *   · Every change is written to the amendment trail with who made it.
 *   · A void purchase cannot be edited at all.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/purchases-edit.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-purchases-edit-'));
Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-purchases-edit';

const express = require('express');
const jwt = require('jsonwebtoken');
const { initDatabase, getDatabase, closeDatabase, now, localDateInTimezone } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { supplierRoutes, purchaseRoutes } = require('../main/routes/purchases');
const { requireModule } = require('../main/services/modules');
const { findStockLedgerMismatches } = require('../main/services/inventory');
const { MODULE_SETTING_KEY } = require('../shared/modules');

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) { passed++; console.log(`  ✓ ${message}`); }
  else { failed++; console.error(`  ✗ ${message}`); }
}
function assertEqual(actual: any, expected: any, message: string) {
  if (actual === expected) { passed++; console.log(`  ✓ ${message}`); }
  else { failed++; console.error(`  ✗ ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
function assertClose(actual: number, expected: number, message: string) {
  if (Math.abs(actual - expected) < 0.0001) { passed++; console.log(`  ✓ ${message}`); }
  else { failed++; console.error(`  ✗ ${message} — expected ${expected}, got ${actual}`); }
}

async function listen(app: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('error', reject);
    server.once('listening', () => resolve(server));
  });
}

async function call(baseUrl: string, method: string, urlPath: string, token: string, body?: unknown) {
  const response = await (globalThis as any).fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}

function isNativeAbiMismatch(error: any): boolean {
  return error?.code === 'ERR_DLOPEN_FAILED' && String(error?.message || '').includes('NODE_MODULE_VERSION');
}

async function main() {
  console.log('Purchases — editing');
  console.log('='.repeat(60));

  try {
    initDatabase();
  } catch (error: any) {
    if (isNativeAbiMismatch(error)) {
      console.log('  ⚠ Skipping: better-sqlite3 ABI mismatch');
      process.exit(77);
    }
    throw error;
  }

  const db = getDatabase();
  const stamp = now();
  const setSetting = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  setSetting.run('timezone', 'America/Bogota', stamp);
  setSetting.run('currency', 'COP', stamp);
  setSetting.run(MODULE_SETTING_KEY.purchases, 'true', stamp);

  for (const [id, role] of [['owner-pe', 'owner'], ['cashier-pe', 'cashier']]) {
    db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(id, role, `${id}@test.local`, 'x', role, stamp, stamp);
  }
  db.prepare(`INSERT INTO categories (id, name, created_at, updated_at) VALUES ('cat-pe', 'Abarrotes', ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO cash_sessions (business_date, opening_float_cents, opened_by, opened_at)
              VALUES (?, 10000000, 'owner-pe', ?)`)
    .run(localDateInTimezone(new Date(), 'America/Bogota'), stamp);

  const seedProduct = (id: string, stock: number, cost: number, unit = 'each') =>
    db.prepare(`INSERT INTO products (id, category_id, name, price, cost, track_inventory, stock_quantity, sale_unit, allow_fractional_quantity, created_at, updated_at)
                VALUES (?, 'cat-pe', ?, 5000, ?, 1, ?, ?, ?, ?, ?)`)
      .run(id, `Producto ${id}`, cost, stock, unit, unit === 'each' ? 0 : 1, stamp, stamp);

  const stockOf = (id: string) =>
    Number((db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(id) as any).stock_quantity);
  const amendmentsOf = (id: number) =>
    db.prepare('SELECT * FROM purchase_amendments WHERE purchase_id = ? ORDER BY id').all(id) as any[];

  const app = express();
  app.use(express.json());
  app.use((req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) { res.status(401).json({ error: 'Authentication required' }); return; }
    try { req.user = jwt.verify(header.split(' ')[1], getJWTSecret()); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  });
  app.use('/api/suppliers', requireModule('purchases'), supplierRoutes);
  app.use('/api/purchases', requireModule('purchases'), purchaseRoutes);

  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const owner = jwt.sign({ userId: 'owner-pe', email: 'owner-pe@test.local', role: 'owner' }, getJWTSecret(), { expiresIn: '1h' });
  const cashier = jwt.sign({ userId: 'cashier-pe', email: 'cashier-pe@test.local', role: 'cashier' }, getJWTSecret(), { expiresIn: '1h' });

  try {
    const s1 = await call(baseUrl, 'POST', '/api/suppliers', owner, { name: 'Mayorista A' });
    const s2 = await call(baseUrl, 'POST', '/api/suppliers', owner, { name: 'Mayorista B' });

    // ── 1. Metadata only ──────────────────────────────────────────────────
    console.log('\n1. Fixing what was typed wrong');
    seedProduct('e-1', 0, 0);
    const created = await call(baseUrl, 'POST', '/api/purchases', owner, {
      supplier_id: s1.data.supplier.id, invoice_ref: '1234', payment_terms: 'credit', due_date: '2026-11-30',
      items: [{ product_id: 'e-1', quantity: 10, unit_cost_cents: 2000 }],
    });
    assertEqual(created.status, 201, 'the purchase is recorded');
    assertClose(stockOf('e-1'), 10, 'stock went up by ten');

    const fixRef = await call(baseUrl, 'PUT', `/api/purchases/${created.data.id}`, owner, {
      invoice_ref: '4321', due_date: '2026-12-15',
    });
    assertEqual(fixRef.status, 200, 'the invoice number and due date can be corrected');
    assertClose(stockOf('e-1'), 10, 'and stock is untouched — nothing about the goods changed');

    const detail = await call(baseUrl, 'GET', `/api/purchases/${created.data.id}`, owner);
    assertEqual(detail.data.purchase.invoice_ref, '4321', 'the new invoice number is stored');
    assertEqual(detail.data.purchase.due_date, '2026-12-15', 'and the new due date');

    const trail = amendmentsOf(created.data.id);
    assertEqual(trail.length, 2, 'both changes are on the amendment trail');
    assert(trail.some((a) => a.field === 'invoice_ref' && a.old_value === '1234' && a.new_value === '4321'),
      'with the old and new invoice number');
    assertEqual(trail[0].amended_by, 'owner-pe', 'and who made the change');

    // ── 2. Raising a quantity adds only the difference ───────────────────
    console.log('\n2. Correcting a quantity upward');
    const up = await call(baseUrl, 'PUT', `/api/purchases/${created.data.id}`, owner, {
      items: [{ product_id: 'e-1', quantity: 15, unit_cost_cents: 2000 }],
    });
    assertEqual(up.status, 200, 'the quantity is corrected to fifteen');
    assertClose(stockOf('e-1'), 15, 'stock is fifteen, not twenty-five — only the difference was added');
    assertEqual(up.data.total_cents, 30000, 'and the total follows the new quantity');

    const movimientos = db.prepare(
      `SELECT * FROM stock_movements WHERE product_id = 'e-1' ORDER BY id`,
    ).all() as any[];
    assertEqual(movimientos.length, 2, 'the correction is its own movement, not a rewrite of the first');
    assertClose(movimientos[1].delta, 5, 'of exactly the five that were missing');

    // ── 3. Lowering a quantity takes the difference back ─────────────────
    console.log('\n3. Correcting a quantity downward');
    const down = await call(baseUrl, 'PUT', `/api/purchases/${created.data.id}`, owner, {
      items: [{ product_id: 'e-1', quantity: 4, unit_cost_cents: 2000 }],
    });
    assertEqual(down.status, 200, 'the quantity is corrected down to four');
    assertClose(stockOf('e-1'), 4, 'and stock follows it down');
    const last = db.prepare(`SELECT * FROM stock_movements WHERE product_id = 'e-1' ORDER BY id DESC LIMIT 1`).get() as any;
    assertClose(last.delta, -11, 'taking back the eleven that never arrived');

    // ── 4. Replacing the lines entirely ──────────────────────────────────
    console.log('\n4. Swapping one product for another');
    seedProduct('e-2', 0, 0);
    const swap = await call(baseUrl, 'PUT', `/api/purchases/${created.data.id}`, owner, {
      items: [{ product_id: 'e-2', quantity: 7, unit_cost_cents: 3000 }],
    });
    assertEqual(swap.status, 200, 'the line can be replaced with a different product');
    assertClose(stockOf('e-1'), 0, 'the first product gives back everything it received');
    assertClose(stockOf('e-2'), 7, 'and the second one receives what it should');

    // ── 5. A correction below what was already paid ──────────────────────
    console.log('\n5. Against what was already paid');
    await call(baseUrl, 'POST', `/api/purchases/${created.data.id}/payments`, owner, {
      amount_cents: 18000, method: 'transfer',
    });
    const tooLow = await call(baseUrl, 'PUT', `/api/purchases/${created.data.id}`, owner, {
      items: [{ product_id: 'e-2', quantity: 1, unit_cost_cents: 1000 }],
    });
    assertEqual(tooLow.status, 409, 'a total below what was already paid is refused');
    assertClose(stockOf('e-2'), 7, 'and nothing about the goods moved');

    const changeSupplier = await call(baseUrl, 'PUT', `/api/purchases/${created.data.id}`, owner, {
      supplier_id: s2.data.supplier.id,
    });
    assertEqual(changeSupplier.status, 409, 'the supplier cannot change once money has been paid to the first one');

    // ── 6. Stock that was already sold ───────────────────────────────────
    console.log('\n6. Correcting goods that were already sold');
    seedProduct('e-3', 0, 0);
    const sold = await call(baseUrl, 'POST', '/api/purchases', owner, {
      supplier_id: s1.data.supplier.id, payment_terms: 'credit', due_date: '2026-12-31',
      items: [{ product_id: 'e-3', quantity: 20, unit_cost_cents: 1000 }],
    });
    const { applyStockMovement } = require('../main/services/inventory');
    applyStockMovement(db, { productId: 'e-3', delta: -18, reason: 'sale' });
    assertClose(stockOf('e-3'), 2, 'eighteen of the twenty were sold');

    const correctSold = await call(baseUrl, 'PUT', `/api/purchases/${sold.data.id}`, owner, {
      items: [{ product_id: 'e-3', quantity: 2, unit_cost_cents: 1000 }],
      reason: 'Llegaron 2, no 20',
    });
    assertEqual(correctSold.status, 200, 'the correction goes through even though the goods are gone');
    assertClose(stockOf('e-3'), -16, 'stock goes negative, which is the truth of what happened');
    const withReason = amendmentsOf(sold.data.id).find((a) => a.reason);
    assertEqual(withReason?.reason, 'Llegaron 2, no 20', 'and the reason given is kept');

    // ── 7. What cannot be edited ─────────────────────────────────────────
    console.log('\n7. What is refused');
    const voidable = await call(baseUrl, 'POST', '/api/purchases', owner, {
      supplier_id: s1.data.supplier.id, payment_terms: 'credit', due_date: '2026-12-31',
      items: [{ product_id: 'e-2', quantity: 1, unit_cost_cents: 1000 }],
    });
    await call(baseUrl, 'POST', `/api/purchases/${voidable.data.id}/void`, owner, { reason: 'Prueba' });
    const editVoid = await call(baseUrl, 'PUT', `/api/purchases/${voidable.data.id}`, owner, { invoice_ref: 'X' });
    assertEqual(editVoid.status, 409, 'a void purchase cannot be edited');

    const missing = await call(baseUrl, 'PUT', '/api/purchases/999999', owner, { invoice_ref: 'X' });
    assertEqual(missing.status, 404, 'neither can one that does not exist');

    const byCashier = await call(baseUrl, 'PUT', `/api/purchases/${created.data.id}`, cashier, { invoice_ref: 'X' });
    assertEqual(byCashier.status, 403, 'and a cashier cannot edit at all');

    const badLines = await call(baseUrl, 'PUT', `/api/purchases/${sold.data.id}`, owner, {
      items: [{ product_id: 'e-3', quantity: -5, unit_cost_cents: 1000 }],
    });
    assertEqual(badLines.status, 400, 'a negative quantity is refused, same as when recording');

    const noDue = await call(baseUrl, 'PUT', `/api/purchases/${sold.data.id}`, owner, {
      payment_terms: 'credit', due_date: null,
    });
    assertEqual(noDue.status, 400, 'credit terms without a due date are refused');

    // ── 8. The ledger still reconciles ───────────────────────────────────
    console.log('\n8. Reconciliation');
    assertEqual(findStockLedgerMismatches(db).length, 0, 'every product still agrees with its last movement');

    const orphanItems = db.prepare(`
      SELECT COUNT(*) AS n FROM purchase_items pi
      LEFT JOIN purchases p ON p.id = pi.purchase_id WHERE p.id IS NULL
    `).get() as { n: number };
    assertEqual(Number(orphanItems.n), 0, 'and rewriting the lines left no orphans behind');

    console.log('\n' + '='.repeat(60));
    console.log(`Results: ${passed}/${passed + failed} passed, ${failed} failed`);
    server.close();
    process.exit(failed > 0 ? 1 : 0);
  } catch (error: any) {
    console.error(`\n✗ Test crashed: ${error.message}`);
    console.error(error.stack);
    server.close();
    process.exit(1);
  } finally {
    closeDatabase();
  }
}

main();
