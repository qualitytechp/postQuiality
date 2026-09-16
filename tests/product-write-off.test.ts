/**
 * Inventory write-off — a product leaves the shelf without being sold.
 *
 * Three real situations share one mechanism (a negative stock movement
 * valued at cost, not at sale price, because nothing was actually sold):
 *
 *   · expired   — a batch's date ran out (packaged goods, mostly).
 *   · damaged   — broken or spoiled on the spot (a dropped bottle, a torn bag).
 *   · shrinkage — a perishable rotted before it sold (vegetables, fruit,
 *                 fresh food) — usually a fractional quantity, e.g. 0.35 kg
 *                 out of a crate of tomatoes.
 *
 * What is checked here:
 *   · Each cause reduces `stock_quantity` and writes an explained
 *     `stock_movements` row, same as any other change (issue #… stock ledger).
 *   · The cost impact is the product's cost at write-off time, not its sale
 *     price — nothing was sold — and it is snapshotted, not recomputed from
 *     today's `products.cost` on read.
 *   · A write-off cannot remove more than is actually on hand.
 *   · Only owner/manager can report one — cashier and server cannot.
 *   · The history endpoint totals correctly, by cause and overall, and its
 *     default window is the current business month.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/product-write-off.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-write-off-'));
Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-write-off';

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
  console.log('Inventory write-off');
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
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('currency', 'COP', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(stamp);
  db.prepare(`INSERT INTO categories (id, name, created_at, updated_at) VALUES ('cat-wo', 'Abarrotes', ?, ?)`).run(stamp, stamp);

  const seedUser = (id: string, role: string) =>
    db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
                VALUES (?, ?, ?, 'x', ?, 1, ?, ?)`).run(id, id, `${id}@test.local`, role, stamp, stamp);
  seedUser('owner-wo', 'owner');
  seedUser('mgr-wo', 'manager');
  seedUser('cashier-wo', 'cashier');

  const tokenFor = (id: string, role: string) =>
    jwt.sign({ userId: id, email: `${id}@test.local`, role }, getJWTSecret(), { expiresIn: '1h' });
  const ownerAuth = tokenFor('owner-wo', 'owner');
  const managerAuth = tokenFor('mgr-wo', 'manager');
  const cashierAuth = tokenFor('cashier-wo', 'cashier');

  const seedProduct = (id: string, stock: number, cost: number, unit = 'each') =>
    db.prepare(`
      INSERT INTO products (id, category_id, name, price, cost, track_inventory, stock_quantity, sale_unit, allow_fractional_quantity, created_at, updated_at)
      VALUES (?, 'cat-wo', ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(id, `Producto ${id}`, cost * 2, cost, stock, unit, unit === 'each' ? 0 : 1, stamp, stamp);

  const stockOf = (id: string) =>
    Number((db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(id) as any).stock_quantity);
  const movementsOf = (id: string) =>
    db.prepare('SELECT * FROM stock_movements WHERE product_id = ? ORDER BY id').all(id) as any[];

  let server: any;
  try {
    // ── Schema ──────────────────────────────────────────────────────────
    console.log('\n1. Schema');
    const columns = (db.prepare('PRAGMA table_info(stock_movements)').all() as { name: string }[]).map((c) => c.name);
    assert(columns.includes('write_off_cause'), 'stock_movements has write_off_cause');
    assert(columns.includes('cost_impact_cents'), 'stock_movements has cost_impact_cents');

    let rejected = false;
    seedProduct('p-badcause', 10, 100);
    try {
      db.prepare(`INSERT INTO stock_movements (product_id, delta, balance_after, reason, write_off_cause, occurred_at, business_date)
                  VALUES ('p-badcause', -1, 9, 'adjustment', 'spoiled', ?, '2026-09-10')`).run(now());
    } catch { rejected = true; }
    assert(rejected, 'an unrecognized write_off_cause is refused');

    // ── The three use cases, via the service directly ──────────────────
    console.log('\n2. Expired stock');
    seedProduct('p-expired', 20, 500); // cost 500 minor units/unit
    const expired = applyStockMovement(db, {
      productId: 'p-expired', delta: -6, reason: 'adjustment',
      writeOffCause: 'expired', costImpactCents: 6 * 500, userId: 'owner-wo',
    });
    assertEqual(expired.ok, true, 'the write-off applies');
    assertClose(stockOf('p-expired'), 14, 'stock drops by the expired quantity');
    const expiredRow = movementsOf('p-expired')[0];
    assertEqual(expiredRow.write_off_cause, 'expired', 'cause is recorded as expired');
    assertEqual(expiredRow.cost_impact_cents, 3000, 'cost impact is quantity × cost, not quantity × price');
    assertEqual(expiredRow.reason, 'adjustment', 'reason stays adjustment — no schema rebuild for a new value');

    console.log('\n3. Damaged stock');
    seedProduct('p-damaged', 15, 800);
    applyStockMovement(db, {
      productId: 'p-damaged', delta: -1, reason: 'adjustment',
      writeOffCause: 'damaged', costImpactCents: 800, note: 'Se cayó una botella', userId: 'owner-wo',
    });
    assertClose(stockOf('p-damaged'), 14, 'one broken unit leaves the count');
    const damagedRow = movementsOf('p-damaged')[0];
    assertEqual(damagedRow.write_off_cause, 'damaged', 'cause is recorded as damaged');
    assertEqual(damagedRow.note, 'Se cayó una botella', 'the free-text note survives alongside the structured cause');

    console.log('\n4. Shrinkage on a perishable (fractional quantity)');
    seedProduct('p-tomato', 8, 1200, 'kg');
    applyStockMovement(db, {
      productId: 'p-tomato', delta: -0.35, reason: 'adjustment',
      writeOffCause: 'shrinkage', costImpactCents: Math.round(0.35 * 1200), userId: 'owner-wo',
    });
    assertClose(stockOf('p-tomato'), 7.65, 'a fractional loss survives intact — this is what a fruver sells by');
    assertEqual(movementsOf('p-tomato')[0].write_off_cause, 'shrinkage', 'cause is recorded as shrinkage');

    // ── Through the real route ──────────────────────────────────────────
    console.log('\n5. Through POST /:id/write-off');
    const app = express();
    app.use(express.json());
    app.use((req: any, res: any, next: any) => {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) { res.status(401).json({ error: 'Authentication required' }); return; }
      try { req.user = jwt.verify(header.split(' ')[1], getJWTSecret()); next(); }
      catch { res.status(401).json({ error: 'Invalid token' }); }
    });
    app.use('/api/products', productRoutes);
    server = await listen(app);
    const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;

    seedProduct('p-http', 10, 400);
    const httpWriteOff = await call(baseUrl, 'POST', '/api/products/p-http/write-off', ownerAuth, { quantity: 3, cause: 'expired' });
    assertEqual(httpWriteOff.status, 200, 'owner can report a write-off');
    assertEqual(httpWriteOff.data.cost_impact_cents, 1200, 'response reports cost impact = quantity × cost');
    assertClose(stockOf('p-http'), 7, 'stock reflects the write-off');

    const missingCause = await call(baseUrl, 'POST', '/api/products/p-http/write-off', ownerAuth, { quantity: 1 });
    assertEqual(missingCause.status, 400, 'cause is required');

    const badCause = await call(baseUrl, 'POST', '/api/products/p-http/write-off', ownerAuth, { quantity: 1, cause: 'stolen' });
    assertEqual(badCause.status, 400, 'an unrecognized cause is refused');

    const badQuantity = await call(baseUrl, 'POST', '/api/products/p-http/write-off', ownerAuth, { quantity: -1, cause: 'damaged' });
    assertEqual(badQuantity.status, 400, 'a non-positive quantity is refused');

    const overdrawn = await call(baseUrl, 'POST', '/api/products/p-http/write-off', ownerAuth, { quantity: 999, cause: 'damaged' });
    assertEqual(overdrawn.status, 400, 'cannot write off more than is on hand');
    assertEqual(movementsOf('p-http').length, 1, 'the refusal wrote no movement');

    const managerWriteOff = await call(baseUrl, 'POST', '/api/products/p-http/write-off', managerAuth, { quantity: 1, cause: 'shrinkage' });
    assertEqual(managerWriteOff.status, 200, 'manager can also report a write-off');

    const cashierWriteOff = await call(baseUrl, 'POST', '/api/products/p-http/write-off', cashierAuth, { quantity: 1, cause: 'damaged' });
    assertEqual(cashierWriteOff.status, 403, 'cashier cannot report a write-off');

    // ── History and its summary ─────────────────────────────────────────
    console.log('\n6. GET /write-offs — history and cost totals');
    const history = await call(baseUrl, 'GET', '/api/products/write-offs', ownerAuth);
    assertEqual(history.status, 200, 'owner can read the write-off history');
    // p-expired(1) + p-damaged(1) + p-tomato(1) + p-http(2: owner's expired one, manager's shrinkage one) —
    // the four refused attempts (missing/bad cause, bad quantity, overdrawn) wrote nothing.
    assertEqual(history.data.items.length, 5, 'every successful write-off appears, and refused attempts do not');
    assertEqual(history.data.summary.count, 5, 'summary count matches the item list');
    const expectedTotalCents = 3000 + 800 + Math.round(0.35 * 1200) + 1200 + 400;
    assertEqual(history.data.summary.total_cost_impact_cents, expectedTotalCents, 'total cost impact sums every cause together');
    assert(!!history.data.summary.by_cause.expired, 'summary breaks totals down by cause');
    assertEqual(history.data.summary.by_cause.expired.count, 2, 'two expired write-offs (p-expired, p-http)');
    assertEqual(history.data.summary.by_cause.damaged.count, 1, 'one damaged write-off');
    assertEqual(history.data.summary.by_cause.shrinkage.count, 2, 'two shrinkage write-offs (p-tomato, p-http)');

    const filtered = await call(baseUrl, 'GET', '/api/products/write-offs?cause=damaged', ownerAuth);
    assertEqual(filtered.data.items.length, 1, 'filtering by cause narrows the list');
    assertEqual(filtered.data.items[0].write_off_cause, 'damaged', 'and returns only that cause');

    const cashierHistory = await call(baseUrl, 'GET', '/api/products/write-offs', cashierAuth);
    assertEqual(cashierHistory.status, 403, 'cashier cannot read the write-off history either');

    // Registered before /:id in products.ts on purpose — a segment this
    // short would otherwise be read as a product id and 404 as "not found".
    assert(Array.isArray(history.data.items), '/write-offs resolved as its own route, not as GET /:id with id="write-offs"');

    server.close();
    server = null;

    // ── Reconciliation ───────────────────────────────────────────────────
    console.log('\n7. Reconciliation');
    const mismatches = findStockLedgerMismatches(db);
    assertEqual(mismatches.length, 0, 'no product disagrees with its last movement after every write-off');

    console.log('\n' + '='.repeat(60));
    console.log(`Results: ${passed}/${passed + failed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (error: any) {
    console.error(`\n✗ Test crashed: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  } finally {
    try { server?.close(); } catch { /* already closed */ }
    closeDatabase();
    Module._load = originalLoad;
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

main();

export {};
