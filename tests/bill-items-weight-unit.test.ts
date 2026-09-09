/**
 * `GET /api/bills/:id` must surface the sold-by-weight facts (sale_unit,
 * weight_precision, allow_fractional_quantity) on each order item, so the
 * receipt can print "0.500 kg" instead of a bare "0.5".
 *
 * order_items only snapshots product_name/product_sku/unit_price at sale
 * time — sale_unit isn't a stored column at all, so getOrderWithItems joins
 * the product at read time (main/routes/bills.ts). This guards that join:
 * present for a weighed line, absent (not just zero) for a plain unit line,
 * and still present after the product is soft-deleted (LEFT JOIN, not INNER).
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-bill-weight-unit-'));

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
  assertEqual,
  getResults,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { billRoutes } = require('../main/routes/bills');

function insertOrderWithItem(db: any, orderTag: string, productId: string, productName: string, quantity: number, unitPrice: number) {
  const orderId = Number(db.prepare(`
    INSERT INTO orders (order_number, type, status, subtotal, total, user_id, created_at, updated_at)
    VALUES (?, 'takeaway', 'completed', ?, ?, 'owner-test-001', ?, ?)
  `).run(`ORD-WEIGHT-${orderTag}`, quantity * unitPrice, quantity * unitPrice, now(), now()).lastInsertRowid);
  db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(orderId, productId, productName, unitPrice, quantity, quantity * unitPrice, quantity * unitPrice, now(), now());
  const billId = db.prepare(`
    INSERT INTO bills (bill_number, order_id, subtotal, total, balance, payment_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, 'paid', ?, ?)
  `).run(`INV-WEIGHT-${orderTag}`, orderId, quantity * unitPrice, quantity * unitPrice, now(), now()).lastInsertRowid;
  return Number(billId);
}

async function main() {
  console.log('Integration Test: bill items expose sale_unit for weighed lines');
  console.log('='.repeat(64));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-weight-unit', 'Produce');
  seedProduct(db, 'prod-avocado', 'cat-weight-unit', 'Avocado', 5000, {
    sale_unit: 'kg', allow_fractional_quantity: true, weight_precision: 3,
  });
  seedProduct(db, 'prod-shampoo', 'cat-weight-unit', 'Shampoo', 19000);

  const app = createApp({ '/api/bills': billRoutes });
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n─── Weighed line ───');
    {
      const billId = insertOrderWithItem(db, 'order-weighed', 'prod-avocado', 'Avocado', 0.5, 5000);
      const res = await api(baseUrl, `/api/bills/${billId}`, { headers: authHeader });
      assertEqual(res.status, 200, 'the bill fetch responds');
      const item = res.data.bill.order.items[0];
      assertEqual(item.sale_unit, 'kg', 'sale_unit is joined onto the item');
      assertEqual(item.weight_precision, 3, 'weight_precision is joined onto the item');
      assertEqual(Number(item.allow_fractional_quantity), 1, 'allow_fractional_quantity is joined onto the item');
      assertEqual(item.quantity, 0.5, 'the fractional quantity itself is unaffected by the join');
    }

    console.log('\n─── Plain unit line ───');
    {
      const billId = insertOrderWithItem(db, 'order-unit', 'prod-shampoo', 'Shampoo', 1, 19000);
      const res = await api(baseUrl, `/api/bills/${billId}`, { headers: authHeader });
      const item = res.data.bill.order.items[0];
      assertEqual(item.sale_unit, 'each', 'a plain product joins its each unit, not a weight unit');
      assertEqual(Number(item.allow_fractional_quantity), 0, 'and fractional quantities stay off');
    }

    console.log('\n─── Soft-deleted product ───');
    {
      // deleted_at only flags the row logically — it still exists to join, so
      // a reprint keeps showing the unit exactly like it already does for
      // product_name. This is the desired "printed truth" behaviour, not a gap.
      db.prepare("UPDATE products SET deleted_at = ? WHERE id = 'prod-avocado'").run(now());
      const billId = insertOrderWithItem(db, 'order-soft-deleted-product', 'prod-avocado', 'Avocado', 0.25, 5000);
      const res = await api(baseUrl, `/api/bills/${billId}`, { headers: authHeader });
      assertEqual(res.status, 200, 'the bill still fetches for a soft-deleted product');
      const item = res.data.bill.order.items[0];
      assertEqual(item.sale_unit, 'kg', 'a soft-deleted product still joins its unit, same as its name');
    }

    console.log('\n─── Product row genuinely gone ───');
    {
      const billId = insertOrderWithItem(db, 'order-orphaned-product', 'prod-never-existed', 'Ghost Item', 1, 1000);
      const res = await api(baseUrl, `/api/bills/${billId}`, { headers: authHeader });
      assertEqual(res.status, 200, 'the bill still fetches (LEFT JOIN, not INNER)');
      const item = res.data.bill.order.items[0];
      assertEqual(item.product_name, 'Ghost Item', 'the sale-time product name snapshot is untouched');
      assertEqual(item.sale_unit, null, 'a product row that no longer exists simply omits the unit, rather than failing the fetch');
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

// A top-level export makes this a module rather than a global script, so its
// top-level names (Module, testDir, assertEqual, ...) stop colliding with the
// same boilerplate names in every other script-style test file under tsc's
// whole-project view. Harmless at runtime: this file has no import consumers.
export {};
