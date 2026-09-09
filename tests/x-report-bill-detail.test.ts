/**
 * `GET /api/reports/x-report/bills` — per-invoice detail behind the "Caja en
 * curso" report, so an owner can see exactly what was billed, not just the
 * aggregate total.
 *
 * The window must match `/x-report` exactly (same open-session-scoped bounds,
 * or the full business day with no session open) — otherwise the bill list
 * a manager expands would not add up to the totals already shown above it.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-x-report-bills-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedCategory,
  seedProduct,
  api,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { reportRoutes } = require('../main/routes/reports');

function insertPaidBill(db: any, tag: string, paidAt: string, lines: { productId: string; name: string; qty: number; unitPrice: number }[], customerId?: string) {
  const total = lines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0);
  const orderId = Number(db.prepare(`
    INSERT INTO orders (order_number, type, status, subtotal, total, user_id, customer_id, created_at, updated_at)
    VALUES (?, 'takeaway', 'completed', ?, ?, 'owner-test-001', ?, ?, ?)
  `).run(`ORD-XRB-${tag}`, total, total, customerId ?? null, paidAt, paidAt).lastInsertRowid);
  for (const line of lines) {
    db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(orderId, line.productId, line.name, line.unitPrice, line.qty, line.qty * line.unitPrice, line.qty * line.unitPrice, paidAt, paidAt);
  }
  const paymentDetails = JSON.stringify([{ method: 'cash', amount: total }]);
  db.prepare(`
    INSERT INTO bills (bill_number, order_id, customer_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 'paid', ?, ?, ?, ?)
  `).run(`INV-XRB-${tag}`, orderId, customerId ?? null, total, total, total, paymentDetails, paidAt, paidAt, paidAt);
}

async function main() {
  console.log('Integration Test: per-invoice detail for the live X window');
  console.log('='.repeat(64));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-xrb', 'Produce');
  seedProduct(db, 'prod-avocado-xrb', 'cat-xrb', 'Avocado', 5000, {
    sale_unit: 'kg', allow_fractional_quantity: true, weight_precision: 3,
  });
  seedProduct(db, 'prod-shampoo-xrb', 'cat-xrb', 'Shampoo', 19000);
  db.prepare(
    `INSERT INTO customers (id, name, is_active, created_at, updated_at) VALUES ('cust-xrb', 'Doris Henao', 1, ?, ?)`
  ).run(now(), now());

  const app = createApp({ '/api/reports': reportRoutes });
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n─── No open session: falls back to the full business day ───');
    {
      // now() rather than a hand-computed UTC date: the endpoint resolves
      // "today" in the tenant's configured timezone (Asia/Kolkata by
      // default here), which a naive UTC slice can straddle around midnight.
      insertPaidBill(db, 'today-1', now(), [
        { productId: 'prod-shampoo-xrb', name: 'Shampoo', qty: 1, unitPrice: 19000 },
      ]);
      const res = await api(baseUrl, '/api/reports/x-report/bills', { headers: authHeader });
      assertEqual(res.status, 200, 'the endpoint responds with no session open');
      assertEqual(res.data.bills.length, 1, 'today\'s bill is included via the full-day fallback window');
      assertEqual(res.data.bills[0].total, 19000, 'the bill total is a plain display-major-unit number, not cents');
    }

    console.log('\n─── Open session: scopes to the session window, not the whole day ───');
    {
      // The endpoint's upper bound is "now" AT REQUEST TIME, not at insert
      // time — timestamps land a few real seconds in the past so the request
      // (fired after these inserts) always lands strictly after them, instead
      // of racing the same wall-clock second the way `now()` would.
      const secondsAgo = (n: number) => new Date(Date.now() - n * 1000).toISOString().replace('T', ' ').slice(0, 19);

      const sessionId = Number(db.prepare(`
        INSERT INTO cash_sessions (business_date, opening_float_cents, opened_by, opened_at)
        VALUES (?, 0, 'owner-test-001', ?)
      `).run(new Date().toISOString().slice(0, 10), secondsAgo(10)).lastInsertRowid);

      // Antes de abrir la caja: no debe aparecer en el detalle del turno.
      insertPaidBill(db, 'before-session', secondsAgo(3600), [
        { productId: 'prod-shampoo-xrb', name: 'Shampoo', qty: 1, unitPrice: 19000 },
      ]);

      // Dentro del turno, con una línea por peso y un cliente asociado.
      insertPaidBill(db, 'weighed', secondsAgo(5), [
        { productId: 'prod-avocado-xrb', name: 'Avocado', qty: 0.5, unitPrice: 5000 },
      ], 'cust-xrb');

      const res = await api(baseUrl, '/api/reports/x-report/bills', { headers: authHeader });
      assertEqual(res.status, 200, 'the endpoint responds with a session open');
      const numbers = res.data.bills.map((b: any) => b.billNumber);
      assert(!numbers.includes('INV-XRB-before-session'), 'a bill paid before the session opened is excluded');
      assert(numbers.includes('INV-XRB-weighed'), 'a bill paid during the open session is included');

      const weighedBill = res.data.bills.find((b: any) => b.billNumber === 'INV-XRB-weighed');
      assertEqual(weighedBill.customerName, 'Doris Henao', 'the customer name is joined onto the bill');
      assertEqual(weighedBill.paymentMethods[0].method, 'cash', 'payment_details is parsed into a method/amount list');
      assertEqual(weighedBill.paymentMethods[0].amount, 2500, 'and the parsed amount matches what was paid');

      const item = weighedBill.items[0];
      assertEqual(item.productName, 'Avocado', 'the item carries its product name');
      assertEqual(item.quantity, 0.5, 'and its fractional quantity');
      assertEqual(item.saleUnit, 'kg', 'a weighed line exposes its sale unit, same as the receipt fix');
      assertEqual(item.weightPrecision, 3, 'and its weight precision');

      db.prepare('DELETE FROM cash_sessions WHERE id = ?').run(sessionId);
    }
  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }

  const { passed, failed, total } = getResults();
  console.log('\n' + '='.repeat(64));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});

// Top-level export: makes this a module, not a global script, so its
// boilerplate names stop colliding with every other script-style test file
// under tsc's whole-project view. No import consumers; harmless at runtime.
export {};
