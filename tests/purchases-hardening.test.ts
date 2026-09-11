/**
 * Purchases — the cases that break things in production
 *
 * The main suite covers the happy paths. This one goes after what a real
 * merchant's week does to the module:
 *
 *   · Instalments that must never over- or under-shoot by a cent, including
 *     in a zero-decimal currency where a "cent" is a peso.
 *   · Two payments racing for the same remaining balance.
 *   · Voiding a purchase that was already partly paid.
 *   · Stock and cost after a sequence of purchases, not just one.
 *   · Fractional weights that do not divide evenly.
 *   · Input a careless caller sends: negative amounts, wrong types, huge
 *     numbers, a supplier that was deactivated between screens.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/purchases-hardening.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-purchases-hard-'));
Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-purchases-hardening';

const express = require('express');
const jwt = require('jsonwebtoken');
const { initDatabase, getDatabase, closeDatabase, now, localDateInTimezone } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { supplierRoutes, purchaseRoutes } = require('../main/routes/purchases');
const { requireModule } = require('../main/services/modules');
const { findStockLedgerMismatches } = require('../main/services/inventory');
const { computeDayAggregates } = require('../main/routes/cash-closures');
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
function assertClose(actual: number, expected: number, message: string, tolerance = 0.0001) {
  if (Math.abs(actual - expected) < tolerance) { passed++; console.log(`  ✓ ${message}`); }
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
  console.log('Purchases — hardening');
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
  // COP has no minor units: a "cent" is a peso. Any rounding that assumes two
  // decimals shows up here rather than in a merchant's books.
  setSetting.run('timezone', 'America/Bogota', stamp);
  setSetting.run('currency', 'COP', stamp);
  setSetting.run(MODULE_SETTING_KEY.purchases, 'true', stamp);

  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
              VALUES ('owner-ph', 'owner', 'owner-ph@test.local', 'x', 'owner', 1, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
              VALUES ('cashier-ph', 'cashier', 'cashier-ph@test.local', 'x', 'cashier', 1, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO categories (id, name, created_at, updated_at) VALUES ('cat-ph', 'Abarrotes', ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO cash_sessions (business_date, opening_float_cents, opened_by, opened_at)
              VALUES (?, 10000000, 'owner-ph', ?)`)
    .run(localDateInTimezone(new Date(), 'America/Bogota'), stamp);

  const seedProduct = (id: string, stock: number, cost: number, tracks: boolean, unit = 'each') =>
    db.prepare(`INSERT INTO products (id, category_id, name, price, cost, track_inventory, stock_quantity, sale_unit, allow_fractional_quantity, created_at, updated_at)
                VALUES (?, 'cat-ph', ?, 5000, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, `Producto ${id}`, cost, tracks ? 1 : 0, stock, unit, unit === 'each' ? 0 : 1, stamp, stamp);

  const productRow = (id: string) => db.prepare('SELECT stock_quantity, cost FROM products WHERE id = ?').get(id) as any;

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
  const owner = jwt.sign({ userId: 'owner-ph', email: 'owner-ph@test.local', role: 'owner' }, getJWTSecret(), { expiresIn: '1h' });
  const cashier = jwt.sign({ userId: 'cashier-ph', email: 'cashier-ph@test.local', role: 'cashier' }, getJWTSecret(), { expiresIn: '1h' });

  try {
    const supplier = await call(baseUrl, 'POST', '/api/suppliers', owner, { name: 'Mayorista Central' });
    const supplierId = supplier.data.supplier.id;

    // ── 1. Instalments add up to the cent ─────────────────────────────────
    console.log('\n1. Instalments that must add up exactly');
    seedProduct('p-1', 0, 0, true);
    const odd = await call(baseUrl, 'POST', '/api/purchases', owner, {
      supplier_id: supplierId, payment_terms: 'credit', due_date: '2026-12-31',
      items: [{ product_id: 'p-1', quantity: 3, unit_cost_cents: 33333 }],
    });
    assertEqual(odd.data.total_cents, 99999, 'a total that does not divide by three');

    let running = 0;
    for (const amount of [33333, 33333]) {
      const r = await call(baseUrl, 'POST', `/api/purchases/${odd.data.id}/payments`, owner, { amount_cents: amount, method: 'transfer' });
      running += amount;
      assertEqual(r.data.paid_cents, running, `after paying ${amount} the total paid is ${running}`);
    }
    const last = await call(baseUrl, 'POST', `/api/purchases/${odd.data.id}/payments`, owner, { method: 'transfer' });
    assertEqual(last.data.paid_cents, 99999, 'the closing instalment lands exactly on the total');
    assertEqual(last.data.balance_cents, 0, 'with nothing left over');

    const sumInDb = db.prepare('SELECT SUM(amount_cents) AS n FROM purchase_payments WHERE purchase_id = ?')
      .get(odd.data.id) as { n: number };
    assertEqual(Number(sumInDb.n), 99999, 'and the stored payments sum to the same figure');

    // ── 2. Two payments racing for the same balance ──────────────────────
    console.log('\n2. Two payments at once');
    const race = await call(baseUrl, 'POST', '/api/purchases', owner, {
      supplier_id: supplierId, payment_terms: 'credit', due_date: '2026-12-31',
      items: [{ product_id: 'p-1', quantity: 1, unit_cost_cents: 50000 }],
    });
    const [a, b] = await Promise.all([
      call(baseUrl, 'POST', `/api/purchases/${race.data.id}/payments`, owner, { amount_cents: 50000, method: 'transfer' }),
      call(baseUrl, 'POST', `/api/purchases/${race.data.id}/payments`, owner, { amount_cents: 50000, method: 'transfer' }),
    ]);
    const accepted = [a, b].filter((r) => r.status === 200).length;
    assertEqual(accepted, 1, 'only one of two simultaneous full payments is accepted');
    const raceTotal = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS n FROM purchase_payments WHERE purchase_id = ?')
      .get(race.data.id) as { n: number };
    assertEqual(Number(raceTotal.n), 50000, 'and the supplier is never paid twice');

    // ── 3. Voiding something already part paid ───────────────────────────
    console.log('\n3. Voiding a part-paid purchase');
    seedProduct('p-2', 5, 1000, true);
    const partPaid = await call(baseUrl, 'POST', '/api/purchases', owner, {
      supplier_id: supplierId, payment_terms: 'credit', due_date: '2026-12-31',
      items: [{ product_id: 'p-2', quantity: 20, unit_cost_cents: 2000 }],
    });
    await call(baseUrl, 'POST', `/api/purchases/${partPaid.data.id}/payments`, owner, { amount_cents: 15000, method: 'transfer' });
    assertClose(productRow('p-2').stock_quantity, 25, 'stock went up by the twenty received');

    const voided = await call(baseUrl, 'POST', `/api/purchases/${partPaid.data.id}/void`, owner, { reason: 'Mercancía devuelta' });
    assertEqual(voided.status, 200, 'it can still be voided');
    assertClose(productRow('p-2').stock_quantity, 5, 'and the stock goes back');

    const stillPaid = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS n FROM purchase_payments WHERE purchase_id = ?')
      .get(partPaid.data.id) as { n: number };
    assertEqual(Number(stillPaid.n), 15000, 'the payment stays on record — money did change hands');

    const afterVoid = await call(baseUrl, 'POST', `/api/purchases/${partPaid.data.id}/payments`, owner, { amount_cents: 1000, method: 'transfer' });
    assertEqual(afterVoid.status, 409, 'but a void purchase takes no further payments');

    const voidRow = (await call(baseUrl, 'GET', '/api/purchases', owner)).data.purchases
      .find((row: any) => row.id === partPaid.data.id);
    assertEqual(voidRow.settlement, 'void', 'and the list reports it as void, not as owing');

    // ── 4. Cost across a sequence of purchases ───────────────────────────
    console.log('\n4. Weighted cost over several purchases');
    seedProduct('p-3', 10, 1000, true);
    for (const [qty, unit] of [[10, 2000], [20, 3000]] as const) {
      await call(baseUrl, 'POST', '/api/purchases', owner, {
        supplier_id: supplierId, payment_terms: 'credit', due_date: '2026-12-31',
        items: [{ product_id: 'p-3', quantity: qty, unit_cost_cents: unit }],
      });
    }
    // 10@1000 → +10@2000 = 20@1500 → +20@3000 = 40@2250
    assertClose(productRow('p-3').stock_quantity, 40, 'stock accumulated across both purchases');
    assertClose(productRow('p-3').cost, 2250, 'and the cost is the running weighted average, not the last price', 0.01);

    // ── 5. Weights that do not divide evenly ─────────────────────────────
    console.log('\n5. Fractional weight');
    seedProduct('p-kg', 0, 0, true, 'kg');
    const weighed = await call(baseUrl, 'POST', '/api/purchases', owner, {
      supplier_id: supplierId, payment_terms: 'credit', due_date: '2026-12-31',
      items: [{ product_id: 'p-kg', quantity: 0.333, unit_cost_cents: 3000 }],
    });
    assertEqual(weighed.data.total_cents, 999, '0.333 kg at 3.000 rounds to a whole peso');
    assertClose(productRow('p-kg').stock_quantity, 0.333, 'and the weight is stored unrounded');

    // ── 6. What a careless caller sends ──────────────────────────────────
    console.log('\n6. Bad input');
    const cases: [string, any, number][] = [
      ['a negative quantity', { supplier_id: supplierId, payment_terms: 'cash', items: [{ product_id: 'p-1', quantity: -5, unit_cost_cents: 1000 }] }, 400],
      ['a zero quantity', { supplier_id: supplierId, payment_terms: 'cash', items: [{ product_id: 'p-1', quantity: 0, unit_cost_cents: 1000 }] }, 400],
      ['a negative unit cost', { supplier_id: supplierId, payment_terms: 'cash', items: [{ product_id: 'p-1', quantity: 1, unit_cost_cents: -1 }] }, 400],
      ['a fractional cent', { supplier_id: supplierId, payment_terms: 'cash', items: [{ product_id: 'p-1', quantity: 1, unit_cost_cents: 10.5 }] }, 400],
      ['a quantity that is not a number', { supplier_id: supplierId, payment_terms: 'cash', items: [{ product_id: 'p-1', quantity: 'mucho', unit_cost_cents: 1000 }] }, 400],
      ['items that are not an array', { supplier_id: supplierId, payment_terms: 'cash', items: { product_id: 'p-1' } }, 400],
      ['no supplier at all', { payment_terms: 'cash', items: [{ product_id: 'p-1', quantity: 1, unit_cost_cents: 1000 }] }, 404],
      ['negative tax', { supplier_id: supplierId, payment_terms: 'cash', tax_cents: -500, items: [{ product_id: 'p-1', quantity: 1, unit_cost_cents: 1000 }] }, 400],
    ];
    for (const [label, body, expected] of cases) {
      const r = await call(baseUrl, 'POST', '/api/purchases', owner, body);
      assertEqual(r.status, expected, `${label} is refused`);
    }

    // Against a purchase that still owes something: a settled one answers
    // "already paid" first, which is the more useful message but not what is
    // under test here.
    const openPurchase = await call(baseUrl, 'POST', '/api/purchases', owner, {
      supplier_id: supplierId, payment_terms: 'credit', due_date: '2026-12-31',
      items: [{ product_id: 'p-1', quantity: 1, unit_cost_cents: 40000 }],
    });
    const badPayment = await call(baseUrl, 'POST', `/api/purchases/${openPurchase.data.id}/payments`, owner, { amount_cents: -100, method: 'transfer' });
    assertEqual(badPayment.status, 400, 'a negative payment is refused');
    const fractionalPayment = await call(baseUrl, 'POST', `/api/purchases/${openPurchase.data.id}/payments`, owner, { amount_cents: 10.5, method: 'transfer' });
    assertEqual(fractionalPayment.status, 400, 'a fractional-cent payment is refused');
    const settledPurchase = await call(baseUrl, 'POST', `/api/purchases/${race.data.id}/payments`, owner, { amount_cents: 100, method: 'transfer' });
    assertEqual(settledPurchase.status, 409, 'and a settled purchase says so rather than complaining about the amount');
    const missingPurchase = await call(baseUrl, 'POST', '/api/purchases/999999/payments', owner, { amount_cents: 100, method: 'transfer' });
    assertEqual(missingPurchase.status, 404, 'paying a purchase that does not exist is refused');

    // ── 7. A supplier deactivated between screens ────────────────────────
    console.log('\n7. A supplier that was deactivated');
    const retiring = await call(baseUrl, 'POST', '/api/suppliers', owner, { name: 'Proveedor que se retira' });
    await call(baseUrl, 'PUT', `/api/suppliers/${retiring.data.supplier.id}`, owner, { is_active: false });
    const toInactive = await call(baseUrl, 'POST', '/api/purchases', owner, {
      supplier_id: retiring.data.supplier.id, payment_terms: 'cash',
      items: [{ product_id: 'p-1', quantity: 1, unit_cost_cents: 1000 }],
    });
    assertEqual(toInactive.status, 400, 'buying from an inactive supplier is refused');

    // ── 8. Who may do what ───────────────────────────────────────────────
    console.log('\n8. Permissions');
    const cashierBuys = await call(baseUrl, 'POST', '/api/purchases', cashier, {
      supplier_id: supplierId, payment_terms: 'cash',
      items: [{ product_id: 'p-1', quantity: 1, unit_cost_cents: 1000 }],
    });
    assertEqual(cashierBuys.status, 403, 'a cashier cannot record a purchase');
    const cashierPays = await call(baseUrl, 'POST', `/api/purchases/${race.data.id}/payments`, cashier, { amount_cents: 100, method: 'transfer' });
    assertEqual(cashierPays.status, 403, 'nor pay a supplier');
    const cashierVoids = await call(baseUrl, 'POST', `/api/purchases/${race.data.id}/void`, cashier, { reason: 'porque sí' });
    assertEqual(cashierVoids.status, 403, 'nor void one');

    // ── 9. Cash leaves the drawer, and the Z knows ───────────────────────
    console.log('\n9. Cash and the register');
    const before = computeDayAggregates(db, localDateInTimezone(new Date(), 'America/Bogota')).carteraCashOutCents;
    const cashBuy = await call(baseUrl, 'POST', '/api/purchases', owner, {
      supplier_id: supplierId, payment_terms: 'cash', payment_method: 'cash',
      items: [{ product_id: 'p-1', quantity: 2, unit_cost_cents: 7000 }],
    });
    assertEqual(cashBuy.status, 201, 'a cash purchase goes through with the drawer open and funded');
    const after = computeDayAggregates(db, localDateInTimezone(new Date(), 'America/Bogota')).carteraCashOutCents;
    assertEqual(after - before, 14000, 'and the close screen sees exactly that leaving the drawer');

    // ── 10. The ledger still reconciles ──────────────────────────────────
    console.log('\n10. Reconciliation');
    assertEqual(findStockLedgerMismatches(db).length, 0, 'no product disagrees with its last stock movement');

    const negativeStock = db.prepare('SELECT COUNT(*) AS n FROM products WHERE stock_quantity < 0').get() as { n: number };
    assertEqual(Number(negativeStock.n), 0, 'and nothing ended up with negative stock');

    const listing = await call(baseUrl, 'GET', '/api/purchases', owner);
    const sumBalances = listing.data.purchases
      .filter((row: any) => row.settlement !== 'void')
      .reduce((sum: number, row: any) => sum + row.balance_cents, 0);
    assertEqual(listing.data.stats.outstanding_cents, sumBalances, 'the headline figure equals the rows it summarises');

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
