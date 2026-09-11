/**
 * Purchases — receiving goods, cost, and voiding
 *
 * What is checked:
 *   · Stock only moves for products that track it, and it moves through the
 *     ledger, so the entry is explained like every other change.
 *   · `products.cost` is re-averaged by weight. That column existed from the
 *     start and until now only the CSV read it; purchases are its first source.
 *   · Voiding writes a compensating movement for what each line actually added
 *     — never a blind subtraction — so a purchase can be voided after some of
 *     the goods were sold.
 *   · Fractional quantities survive, which is how a fruver buys.
 *   · Credit terms are refused while the receivables module is off: with no
 *     surface to show the debt, accepting it would strand a balance.
 *   · A bad line leaves nothing behind — no half-written purchase.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/purchases.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-purchases-'));
Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-purchases';

const express = require('express');
const jwt = require('jsonwebtoken');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { supplierRoutes, purchaseRoutes } = require('../main/routes/purchases');
const { requireModule } = require('../main/services/modules');
const { weightedAverageCost } = require('../main/services/purchases');
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
  console.log('Purchases');
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
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  setSetting.run('timezone', 'America/Bogota', stamp);
  setSetting.run('currency', 'COP', stamp);
  // COP has no minor units, so a "cent" is a peso. Purchases must respect the
  // currency's own factor rather than assuming two decimals.
  setSetting.run(MODULE_SETTING_KEY.purchases, 'true', stamp);

  for (const [id, role] of [['owner-pu', 'owner'], ['manager-pu', 'manager']]) {
    db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(id, role, `${id}@test.local`, 'x', role, stamp, stamp);
  }
  db.prepare(`INSERT INTO categories (id, name, created_at, updated_at) VALUES ('cat-pu', 'Abarrotes', ?, ?)`)
    .run(stamp, stamp);

  const seedProduct = (id: string, stock: number, cost: number, tracks: boolean, unit = 'each') =>
    db.prepare(`INSERT INTO products (id, category_id, name, price, cost, track_inventory, stock_quantity, sale_unit, allow_fractional_quantity, created_at, updated_at)
                VALUES (?, 'cat-pu', ?, 5000, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, `Producto ${id}`, cost, tracks ? 1 : 0, stock, unit, unit === 'each' ? 0 : 1, stamp, stamp);

  const productRow = (id: string) =>
    db.prepare('SELECT stock_quantity, cost FROM products WHERE id = ?').get(id) as any;
  const movementsOf = (id: string) =>
    db.prepare('SELECT * FROM stock_movements WHERE product_id = ? ORDER BY id').all(id) as any[];

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
  const tokenFor = (id: string, role: string) =>
    jwt.sign({ userId: id, email: `${id}@test.local`, role }, getJWTSecret(), { expiresIn: '1h' });
  const owner = tokenFor('owner-pu', 'owner');
  const manager = tokenFor('manager-pu', 'manager');

  try {
    // ── 1. The weighted average, on its own ──────────────────────────────
    console.log('\n1. Weighted average cost');
    assertClose(weightedAverageCost(10, 1800, 50, 2000), (10 * 1800 + 50 * 2000) / 60, '10 @ 1800 plus 50 @ 2000');
    assertClose(weightedAverageCost(0, 1800, 50, 2000), 2000, 'with nothing on hand the purchase price is the cost');
    assertClose(weightedAverageCost(-3, 1800, 50, 2000), 2000, 'a negative balance is not averaged against');
    assertClose(weightedAverageCost(10, 1800, 0, 2000), 1800, 'buying nothing changes nothing');

    // ── 2. A supplier is needed first ────────────────────────────────────
    console.log('\n2. Suppliers');
    const noName = await call(baseUrl, 'POST', '/api/suppliers', owner, { name: '   ' });
    assertEqual(noName.status, 400, 'a supplier needs a name');

    const supplier = await call(baseUrl, 'POST', '/api/suppliers', owner, {
      name: 'Distribuidora El Roble', phone: '3147157869', document: '900.123.456-1',
    });
    assertEqual(supplier.status, 201, 'the supplier is created');
    const supplierId = supplier.data.supplier.id;
    assertEqual(supplier.data.supplier.is_active, 1, 'and starts active');

    // ── 3. Receiving a purchase ──────────────────────────────────────────
    console.log('\n3. Receiving');
    seedProduct('p-arroz', 10, 1800, true);
    seedProduct('p-sinstock', 0, 0, false);   // no lleva existencias
    const received = await call(baseUrl, 'POST', '/api/purchases', manager, {
      supplier_id: supplierId,
      invoice_ref: 'FV-9912',
      payment_terms: 'cash',
      payment_method: 'cash',
      items: [
        { product_id: 'p-arroz', quantity: 50, unit_cost_cents: 2000 },
        { product_id: 'p-sinstock', quantity: 3, unit_cost_cents: 1500 },
        { description: 'Flete', quantity: 1, unit_cost_cents: 30000 },
      ],
    });
    assertEqual(received.status, 201, 'the purchase is recorded');
    assert(/^COM-\d{8}-\d{4}$/.test(received.data.purchase_number), `numbered COM-YYYYMMDD-NNNN (${received.data.purchase_number})`);
    assertEqual(received.data.total_cents, 50 * 2000 + 3 * 1500 + 30000, 'the total is the sum of the lines');

    const arroz = productRow('p-arroz');
    assertClose(arroz.stock_quantity, 60, 'stock went from 10 to 60');
    assertClose(arroz.cost, (10 * 1800 + 50 * 2000) / 60, 'cost is the weighted average, not the last price');

    const arrozMoves = movementsOf('p-arroz');
    assertEqual(arrozMoves.length, 1, 'the entry is one ledger movement');
    assertEqual(arrozMoves[0].reason, 'purchase', 'with reason "purchase"');
    assertEqual(arrozMoves[0].ref_type, 'purchase_item', 'pointing back at the line that caused it');
    assertEqual(arrozMoves[0].created_by, 'manager-pu', 'and recording who received it');

    assertEqual(movementsOf('p-sinstock').length, 0, 'a product that does not track stock moves none');
    assertClose(productRow('p-sinstock').cost, 1500, 'but its cost is still updated');

    const detail = await call(baseUrl, 'GET', `/api/purchases/${received.data.id}`, owner);
    assertEqual(detail.data.items.length, 3, 'all three lines are kept');
    assertEqual(detail.data.items[2].product_id, null, 'a freight line carries no product');
    assertEqual(detail.data.items[2].description, 'Flete', 'and keeps its own description');
    assertClose(detail.data.items[0].inventory_added_quantity, 50, 'the line records what actually entered stock');
    assertClose(detail.data.items[1].inventory_added_quantity, 0, 'and zero when the product does not track it');
    assertEqual(detail.data.purchase.balance_cents, 0, 'a cash purchase settles at once');
    assertEqual(detail.data.payments.length, 1, 'with one payment covering the total');

    // ── 4. Buying by weight ──────────────────────────────────────────────
    console.log('\n4. Buying by weight');
    seedProduct('p-tomate', 4.5, 3000, true, 'kg');
    const byWeight = await call(baseUrl, 'POST', '/api/purchases', owner, {
      supplier_id: supplierId, payment_terms: 'cash',
      items: [{ product_id: 'p-tomate', quantity: 25.5, unit_cost_cents: 2800 }],
    });
    assertEqual(byWeight.status, 201, 'a fractional quantity is accepted');
    assertClose(productRow('p-tomate').stock_quantity, 30, '4.5 kg + 25.5 kg = 30 kg');
    const tomateDetail = await call(baseUrl, 'GET', `/api/purchases/${byWeight.data.id}`, owner);
    assertEqual(tomateDetail.data.items[0].unit, 'kg', 'the line inherits the product unit');

    // ── 5. Voiding compensates, never subtracts blindly ──────────────────
    console.log('\n5. Voiding');
    // Sell most of it first: the goods are gone before the purchase is voided.
    const { applyStockMovement } = require('../main/services/inventory');
    applyStockMovement(db, { productId: 'p-tomate', delta: -28, reason: 'sale' });
    assertClose(productRow('p-tomate').stock_quantity, 2, '28 kg sold, 2 kg left');

    const voided = await call(baseUrl, 'POST', `/api/purchases/${byWeight.data.id}/void`, owner, {
      reason: 'Se digitaron 25.5 kg en vez de 2.5',
    });
    assertEqual(voided.status, 200, 'the purchase can still be voided');
    assertClose(productRow('p-tomate').stock_quantity, -23.5, 'the balance goes negative rather than being fudged');
    const tomateMoves = movementsOf('p-tomate');
    assertEqual(tomateMoves[tomateMoves.length - 1].reason, 'purchase_void', 'the reversal is its own movement');
    assertClose(tomateMoves[tomateMoves.length - 1].delta, -25.5, 'reversing exactly what the line added');

    const voidedRow = await call(baseUrl, 'GET', `/api/purchases/${byWeight.data.id}`, owner);
    assertEqual(voidedRow.data.purchase.status, 'void', 'the purchase is marked void, not deleted');
    assert(!!voidedRow.data.purchase.void_reason, 'and keeps the reason it was voided');

    const twice = await call(baseUrl, 'POST', `/api/purchases/${byWeight.data.id}/void`, owner, { reason: 'otra vez' });
    assertEqual(twice.status, 409, 'voiding twice is refused');

    const noReason = await call(baseUrl, 'POST', `/api/purchases/${received.data.id}/void`, owner, {});
    assertEqual(noReason.status, 400, 'voiding without a reason is refused');

    // ── 6. Composition: credit needs the other module ────────────────────
    console.log('\n6. Credit terms need receivables');
    const credit = await call(baseUrl, 'POST', '/api/purchases', owner, {
      supplier_id: supplierId, payment_terms: 'credit', due_date: '2026-12-31',
      items: [{ product_id: 'p-arroz', quantity: 1, unit_cost_cents: 2000 }],
    });
    assertEqual(credit.status, 400, 'a credit purchase is refused while receivables is off');
    assertEqual(credit.data.module, 'receivables', 'and names the module that would allow it');

    setSetting.run(MODULE_SETTING_KEY.receivables, 'true', now());
    const creditOk = await call(baseUrl, 'POST', '/api/purchases', owner, {
      supplier_id: supplierId, payment_terms: 'credit', due_date: '2026-12-31',
      items: [{ product_id: 'p-arroz', quantity: 1, unit_cost_cents: 2000 }],
    });
    assertEqual(creditOk.status, 201, 'with receivables on it goes through');
    const creditDetail = await call(baseUrl, 'GET', `/api/purchases/${creditOk.data.id}`, owner);
    assertEqual(creditDetail.data.purchase.balance_cents, 2000, 'and leaves an outstanding balance');
    assertEqual(creditDetail.data.payments.length, 0, 'with no payment recorded yet');

    const noDueDate = await call(baseUrl, 'POST', '/api/purchases', owner, {
      supplier_id: supplierId, payment_terms: 'credit',
      items: [{ product_id: 'p-arroz', quantity: 1, unit_cost_cents: 2000 }],
    });
    assertEqual(noDueDate.status, 400, 'credit without a due date is refused');

    // ── 7. A bad line leaves nothing behind ──────────────────────────────
    console.log('\n7. Nothing half-written');
    const before = (db.prepare('SELECT COUNT(*) AS c FROM purchases').get() as any).c;
    const stockBefore = productRow('p-arroz').stock_quantity;
    const bad = await call(baseUrl, 'POST', '/api/purchases', owner, {
      supplier_id: supplierId, payment_terms: 'cash',
      items: [
        { product_id: 'p-arroz', quantity: 5, unit_cost_cents: 2000 },
        { product_id: 'no-existe', quantity: 1, unit_cost_cents: 100 },
      ],
    });
    assertEqual(bad.status, 404, 'an unknown product on the second line fails the whole purchase');
    assertEqual((db.prepare('SELECT COUNT(*) AS c FROM purchases').get() as any).c, before, 'no purchase row was written');
    assertClose(productRow('p-arroz').stock_quantity, stockBefore, 'and the good line did not move stock either');

    const noItems = await call(baseUrl, 'POST', '/api/purchases', owner, {
      supplier_id: supplierId, payment_terms: 'cash', items: [],
    });
    assertEqual(noItems.status, 400, 'a purchase with no lines is refused');

    const badSupplier = await call(baseUrl, 'POST', '/api/purchases', owner, {
      supplier_id: 'nadie', payment_terms: 'cash',
      items: [{ product_id: 'p-arroz', quantity: 1, unit_cost_cents: 1 }],
    });
    assertEqual(badSupplier.status, 404, 'an unknown supplier is refused');

    // ── 8. The ledger still reconciles ───────────────────────────────────
    console.log('\n8. Reconciliation');
    assertEqual(findStockLedgerMismatches(db).length, 0, 'no product disagrees with its last movement');

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
