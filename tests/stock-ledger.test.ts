/**
 * Stock ledger — every change to inventory leaves a trace
 *
 * `products.stock_quantity` used to be written from eight places with no
 * history, so the running total could not be explained or checked. It is still
 * the authoritative balance; what changed is that the same write now records a
 * `stock_movements` row, and `balance_after` makes the two reconcilable.
 *
 * What is checked here:
 *   · The column and the ledger agree after every kind of change.
 *   · Each movement carries a reason and a reference back to what caused it.
 *   · A removal that would overdraw is refused, and refusing writes nothing.
 *   · A reversal may push the balance below zero — the goods can genuinely be
 *     gone already, and refusing would leave the ledger disagreeing with
 *     reality. What matters is that it stays explained.
 *   · Fractional quantities survive intact, which is what a fruver sells by.
 *   · `set` records the delta it actually applied, not the number typed.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/stock-ledger.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-stock-ledger-'));
Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-stock-ledger';

const express = require('express');
const jwt = require('jsonwebtoken');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { productRoutes } = require('../main/routes/products');
const { applyStockMovement, findStockLedgerMismatches } = require('../main/services/inventory');

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

function isNativeAbiMismatch(error: any): boolean {
  return error?.code === 'ERR_DLOPEN_FAILED' && String(error?.message || '').includes('NODE_MODULE_VERSION');
}

async function main() {
  console.log('Stock ledger');
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
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('timezone', 'America/Bogota', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(stamp);
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
              VALUES ('owner-sl', 'owner', 'owner-sl@test.local', 'x', 'owner', 1, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO categories (id, name, created_at, updated_at) VALUES ('cat-sl', 'Verduras', ?, ?)`)
    .run(stamp, stamp);

  const seedProduct = (id: string, stock: number, unit = 'each') =>
    db.prepare(`INSERT INTO products (id, category_id, name, price, track_inventory, stock_quantity, sale_unit, allow_fractional_quantity, created_at, updated_at)
                VALUES (?, 'cat-sl', ?, 1000, 1, ?, ?, ?, ?, ?)`)
      .run(id, `Producto ${id}`, stock, unit, unit === 'each' ? 0 : 1, stamp, stamp);

  const stockOf = (id: string) =>
    Number((db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(id) as any).stock_quantity);
  const movementsOf = (id: string) =>
    db.prepare('SELECT * FROM stock_movements WHERE product_id = ? ORDER BY id').all(id) as any[];

  try {
    // ── 1. The table exists with its guards ──────────────────────────────
    console.log('\n1. Schema');
    const tableExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stock_movements'`,
    ).get();
    assert(!!tableExists, 'stock_movements exists at the current schema version');

    seedProduct('p-guard', 10);
    let rejectedByCheck = false;
    try {
      db.prepare(`INSERT INTO stock_movements (product_id, delta, balance_after, reason, occurred_at, business_date)
                  VALUES ('p-guard', 0, 10, 'adjustment', ?, '2026-09-10')`).run(now());
    } catch { rejectedByCheck = true; }
    assert(rejectedByCheck, 'a zero movement is refused — a no-op is not an event');

    let badReason = false;
    try {
      db.prepare(`INSERT INTO stock_movements (product_id, delta, balance_after, reason, occurred_at, business_date)
                  VALUES ('p-guard', 1, 11, 'inventado', ?, '2026-09-10')`).run(now());
    } catch { badReason = true; }
    assert(badReason, 'an unknown reason is refused');

    // ── 2. A sale removes and records ────────────────────────────────────
    console.log('\n2. A sale');
    seedProduct('p-sale', 20);
    const sold = applyStockMovement(db, {
      productId: 'p-sale', delta: -3, reason: 'sale',
      refType: 'order_item', refId: 77, userId: 'owner-sl',
    });
    assertEqual(sold.ok, true, 'the sale applies');
    assertClose(sold.balanceAfter, 17, 'balance returned is 17');
    assertClose(stockOf('p-sale'), 17, 'the column says 17');
    const saleRows = movementsOf('p-sale');
    assertEqual(saleRows.length, 1, 'exactly one movement was written');
    assertClose(saleRows[0].delta, -3, 'the movement records −3');
    assertClose(saleRows[0].balance_after, 17, 'the movement records the resulting balance');
    assertEqual(saleRows[0].reason, 'sale', 'the reason is recorded');
    assertEqual(saleRows[0].ref_type, 'order_item', 'the reference type points back to the cause');
    assertEqual(saleRows[0].ref_id, '77', 'the reference id points back to the cause');
    assertEqual(saleRows[0].created_by, 'owner-sl', 'who did it is recorded');
    assert(/^\d{4}-\d{2}-\d{2}$/.test(saleRows[0].business_date), 'the business date is a local calendar date');

    // ── 3. Cancelling puts it back ───────────────────────────────────────
    console.log('\n3. Cancelling');
    applyStockMovement(db, {
      productId: 'p-sale', delta: 3, reason: 'sale_cancel',
      refType: 'order_item', refId: 77, allowNegative: true,
    });
    assertClose(stockOf('p-sale'), 20, 'the column is back to 20');
    const afterCancel = movementsOf('p-sale');
    assertEqual(afterCancel.length, 2, 'the cancellation is its own movement, not an erasure');
    assertEqual(afterCancel[0].delta, -3, 'the original sale is still on record');
    assertEqual(afterCancel[1].reason, 'sale_cancel', 'the second movement says why');
    assert(afterCancel[1].created_by === null, 'a system-made movement records no user');

    // ── 4. Overdrawing is refused, and writes nothing ────────────────────
    console.log('\n4. Refusing to overdraw');
    seedProduct('p-short', 2);
    const refused = applyStockMovement(db, { productId: 'p-short', delta: -5, reason: 'adjustment' });
    assertEqual(refused.ok, false, 'removing more than there is fails');
    assertEqual(refused.reason, 'insufficient', 'and says why');
    assertClose(stockOf('p-short'), 2, 'the column was left alone');
    assertEqual(movementsOf('p-short').length, 0, 'a refused change writes no movement');

    const missing = applyStockMovement(db, { productId: 'no-existe', delta: 1, reason: 'adjustment' });
    assertEqual(missing.ok, false, 'an unknown product fails');
    assertEqual(missing.reason, 'not_found', 'and is told apart from a shortfall');

    // ── 5. A reversal may go negative, but stays explained ───────────────
    console.log('\n5. A reversal may go below zero');
    seedProduct('p-neg', 1);
    const negative = applyStockMovement(db, {
      productId: 'p-neg', delta: -4, reason: 'purchase_void', allowNegative: true,
    });
    assertEqual(negative.ok, true, 'reversing a purchase whose goods were already sold is allowed');
    assertClose(stockOf('p-neg'), -3, 'the balance goes to −3');
    assertClose(movementsOf('p-neg')[0].balance_after, -3, 'and the ledger says so plainly');

    // ── 6. Fractional quantities survive ─────────────────────────────────
    console.log('\n6. Weight, not just units');
    seedProduct('p-kg', 50.5, 'kg');
    applyStockMovement(db, { productId: 'p-kg', delta: -1.25, reason: 'sale' });
    assertClose(stockOf('p-kg'), 49.25, '50.5 kg − 1.25 kg = 49.25 kg');
    assertClose(movementsOf('p-kg')[0].delta, -1.25, 'the fractional delta is stored intact');

    // ── 7. `set` records the delta it applied ────────────────────────────
    console.log('\n7. Setting an absolute figure');
    seedProduct('p-set', 12);
    applyStockMovement(db, {
      productId: 'p-set', delta: 30 - stockOf('p-set'), reason: 'adjustment', note: 'set',
    });
    assertClose(stockOf('p-set'), 30, 'the count is now 30');
    assertClose(movementsOf('p-set')[0].delta, 18, 'the movement records +18, the change that happened');

    // Setting the same figure again is not an event.
    const noop = applyStockMovement(db, { productId: 'p-set', delta: 0, reason: 'adjustment', note: 'set' });
    assertEqual(noop.ok, true, 'setting the figure it already has succeeds');
    assertEqual(movementsOf('p-set').length, 1, 'and writes no second movement');

    // ── 8. Through the real route ────────────────────────────────────────
    // Calling the service directly cannot catch a route that reads the wrong
    // field off the token, which is exactly how `created_by` silently became
    // null the first time. This goes the whole way through HTTP.
    console.log('\n8. Through the adjustment endpoint');
    seedProduct('p-http', 8);
    const app = express();
    app.use(express.json());
    app.use((req: any, res: any, next: any) => {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) { res.status(401).json({ error: 'Authentication required' }); return; }
      try { req.user = jwt.verify(header.split(' ')[1], getJWTSecret()); next(); }
      catch { res.status(401).json({ error: 'Invalid token' }); }
    });
    app.use('/api/products', productRoutes);
    const server = await listen(app);
    const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
    const token = jwt.sign(
      { userId: 'owner-sl', email: 'owner-sl@test.local', role: 'owner' },
      getJWTSecret(), { expiresIn: '1h' },
    );

    const increased = await call(baseUrl, 'POST', '/api/products/p-http/stock', token, { action: 'increase', quantity: 4 });
    assertEqual(increased.status, 200, 'increase succeeds');
    assertClose(stockOf('p-http'), 12, 'the column went to 12');
    const httpRows = movementsOf('p-http');
    assertEqual(httpRows.length, 1, 'the endpoint wrote a movement');
    assertEqual(httpRows[0].created_by, 'owner-sl', 'the movement records the signed-in user, not null');
    assertEqual(httpRows[0].reason, 'adjustment', 'the reason is adjustment');
    assertEqual(httpRows[0].note, 'increase', 'the note keeps which action was used');

    const overdrawn = await call(baseUrl, 'POST', '/api/products/p-http/stock', token, { action: 'decrease', quantity: 99 });
    assertEqual(overdrawn.status, 400, 'decreasing past zero is still refused');
    assertEqual(overdrawn.data.error, 'Insufficient stock', 'with the same message as before the ledger existed');
    assertEqual(movementsOf('p-http').length, 1, 'and the refusal wrote no movement');
    server.close();

    // ── 9. Column and ledger agree ───────────────────────────────────────
    console.log('\n9. Reconciliation');
    const mismatches = findStockLedgerMismatches(db);
    assertEqual(mismatches.length, 0, 'no product has a column that disagrees with its last movement');

    console.log('\n' + '='.repeat(60));
    console.log(`Results: ${passed}/${passed + failed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (error: any) {
    console.error(`\n✗ Test crashed: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  } finally {
    closeDatabase();
  }
}

main();
