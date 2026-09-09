/**
 * Report Builder — whitelist, timezone window and allocation
 *
 * The custom report generator turns a client-supplied definition into SQL.
 * The whole security model is that identifiers are looked up in
 * `main/reports/catalog.ts` and never concatenated, so these tests hammer the
 * rejection path as hard as the happy path.
 *
 * Also covers the two ways a report can silently lie:
 *  - money filtered by the UTC date instead of the store's business day, which
 *    pushes an evening sale into the next day
 *  - totals summed from the displayed rows, which double-counts a bill that
 *    touches two categories
 *
 * Usage: node tests/run-electron-node-test.cjs tests/report-builder.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-report-builder-'));
Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-report-builder';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { reportQueryRoutes } = require('../main/routes/report-query');

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

async function listen(app: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('error', reject);
    server.once('listening', () => resolve(server));
  });
}

async function post(baseUrl: string, urlPath: string, token: string, body: unknown) {
  const response = await (globalThis as any).fetch(baseUrl + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
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
  console.log('Report Builder');
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
  // A store five hours behind UTC, so a late sale lands on the next UTC day.
  const setSetting = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  setSetting.run('timezone', 'America/Bogota', now());
  setSetting.run('currency', 'COP', now());

  const ownerId = 'owner-report-builder';
  const managerId = 'manager-report-builder';
  const stamp = now();
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(ownerId, 'Owner', 'owner-rb@test.local', bcrypt.hashSync('password', 10), 'owner', stamp, stamp);
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(managerId, 'Manager', 'manager-rb@test.local', bcrypt.hashSync('password', 10), 'manager', stamp, stamp);

  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)`).run('cat-pizza', 'Pizzas', 1);
  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)`).run('cat-bebida', 'Bebidas', 2);
  db.prepare(`INSERT INTO products (id, category_id, name, price, is_active, sort_order) VALUES (?, ?, ?, ?, 1, ?)`)
    .run('prod-pizza', 'cat-pizza', 'Pizza', 40000, 1);
  db.prepare(`INSERT INTO products (id, category_id, name, price, is_active, sort_order) VALUES (?, ?, ?, ?, 1, ?)`)
    .run('prod-cerveza', 'cat-bebida', 'Cerveza', 10000, 2);

  // One order, two categories, paid at 01:30 UTC on Sep 9 — which is 20:30 on
  // Sep 8 in Bogota. A UTC-date filter would file this under the 9th.
  const paidAt = '2026-09-09 01:30:00';
  db.prepare(`INSERT INTO orders (id, order_number, user_id, type, status, subtotal, tax_amount, total, created_at, updated_at)
              VALUES (1, 'ORD-1', ?, 'dine_in', 'completed', 50000, 0, 50000, ?, ?)`)
    .run(ownerId, paidAt, paidAt);
  db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
              VALUES (1, 'prod-pizza', 'Pizza', 40000, 1, 40000, 0, 40000, 'served', ?, ?)`).run(paidAt, paidAt);
  db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
              VALUES (1, 'prod-cerveza', 'Cerveza', 10000, 1, 10000, 0, 10000, 'served', ?, ?)`).run(paidAt, paidAt);
  db.prepare(`INSERT INTO bills (id, bill_number, order_id, subtotal, tax_amount, discount_amount, service_charge, delivery_charge, packaging_charge, total, paid_amount, balance, payment_status, paid_at, created_at, updated_at)
              VALUES (1, 'BILL-1', 1, 50000, 0, 0, 0, 0, 0, 50000, 50000, 0, 'paid', ?, ?, ?)`)
    .run(paidAt, paidAt, paidAt);

  const app = express();
  app.use(express.json());
  app.use((req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) { res.status(401).json({ error: 'Authentication required' }); return; }
    try { req.user = jwt.verify(header.split(' ')[1], getJWTSecret()); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  });
  app.use('/api/reports', reportQueryRoutes);

  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const ownerToken = jwt.sign({ userId: ownerId, email: 'owner-rb@test.local', role: 'owner' }, getJWTSecret(), { expiresIn: '1h' });
  const managerToken = jwt.sign({ userId: managerId, email: 'manager-rb@test.local', role: 'manager' }, getJWTSecret(), { expiresIn: '1h' });

  const query = (body: unknown, token = ownerToken) => post(baseUrl, '/api/reports/query', token, body);
  const base = { measures: ['gross_sales'], dimensions: [], filters: [], from: '2026-09-01', to: '2026-09-08' };

  try {
    console.log('\n1. Only the owner reaches the generator');
    {
      const res = await query(base, managerToken);
      assertEqual(res.status, 403, 'manager is refused');
      const ok = await query(base);
      assertEqual(ok.status, 200, 'owner is allowed');
    }

    console.log('\n2. The window follows the store day, not the UTC date');
    {
      const res = await query({ ...base, dimensions: ['day'] });
      assertEqual(res.status, 200, 'grouped-by-day query succeeds');
      assertEqual(res.data.rows.length, 1, 'the evening sale lands on exactly one day');
      assertEqual(res.data.rows[0]?.dimensions?.day?.label, '2026-09-08',
        'a 01:30 UTC sale is filed under the store day that was still running');
      assertEqual(res.data.totals.gross_sales, 50000, 'the full bill is inside the window');

      const before = await query({ ...base, from: '2026-09-09', to: '2026-09-09' });
      assertEqual(before.data.totals.gross_sales, 0, 'the following store day is empty');
    }

    console.log('\n3. Item-level dimensions allocate the bill, and say so');
    {
      const res = await query({ ...base, dimensions: ['category'], measures: ['gross_sales', 'bill_count'] });
      assertEqual(res.status, 200, 'grouped-by-category query succeeds');
      assertEqual(res.data.allocated, true, 'the response declares the amounts were allocated');
      const byLabel: Record<string, number> = {};
      for (const row of res.data.rows) byLabel[row.dimensions.category.label] = Math.round(row.values.gross_sales);
      assertEqual(byLabel['Pizzas'], 40000, 'the pizza keeps its share of the bill');
      assertEqual(byLabel['Bebidas'], 10000, 'the drink keeps its share of the bill');
      assertEqual(
        Math.round(res.data.rows.reduce((s: number, r: any) => s + r.values.gross_sales, 0)),
        50000,
        'the allocated shares add back up to the bill',
      );
    }

    console.log('\n4. Totals are counted, not summed from the rows');
    {
      const res = await query({ ...base, dimensions: ['category'], measures: ['gross_sales', 'bill_count'] });
      const summed = res.data.rows.reduce((s: number, r: any) => s + r.values.bill_count, 0);
      assertEqual(summed, 2, 'the one bill appears in both category rows');
      assertEqual(res.data.totals.bill_count, 1,
        'the total still says one bill — summing the rows would have said two');
    }

    console.log('\n5. Every identifier is looked up, never concatenated');
    {
      const attacks: [string, any][] = [
        ['dimension', { ...base, dimensions: ["o.type; DROP TABLE bills--"] }],
        ['measure', { ...base, measures: ['(SELECT password FROM users)'] }],
        ['filter field', { ...base, filters: [{ field: '1=1--', operator: 'eq', value: 'x' }] }],
        ['operator', { ...base, filters: [{ field: 'order_type', operator: '= 1 OR 1=1 --', value: 'x' }] }],
        ['sort key', { ...base, sort: { key: 'gross_sales; DROP TABLE bills--', direction: 'desc' } }],
      ];
      for (const [label, body] of attacks) {
        const res = await query(body);
        // A rejected identifier is a 400; an unknown sort key is simply ignored.
        assert(res.status === 400 || res.status === 200, `${label} injection does not error the server`);
        assert(res.status !== 500, `${label} injection is not an internal error`);
      }
      const stillThere = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bills'").get();
      assert(!!stillThere, 'the bills table survived every injection attempt');
      assertEqual(db.prepare('SELECT COUNT(*) n FROM bills').get().n, 1, 'the bill row survived too');
    }

    console.log('\n6. Filter values are bound, not interpolated');
    {
      const res = await query({
        ...base,
        filters: [{ field: 'order_type', operator: 'eq', value: "dine_in' OR '1'='1" }],
      });
      assertEqual(res.status, 200, 'a quoted value is accepted as data');
      assertEqual(res.data.totals.gross_sales, 0, 'and matches nothing, because it is a literal');
    }

    console.log('\n7. The definition itself is validated');
    {
      const cases: [string, any][] = [
        ['no measures', { ...base, measures: [] }],
        ['three dimensions', { ...base, dimensions: ['day', 'category', 'staff'] }],
        ['bad date', { ...base, from: 'ayer' }],
        ['inverted range', { ...base, from: '2026-09-30', to: '2026-09-01' }],
        ['operator that does not apply', { ...base, filters: [{ field: 'order_type', operator: 'gt', value: 'x' }] }],
      ];
      for (const [label, body] of cases) {
        const res = await query(body);
        assertEqual(res.status, 400, `${label} is rejected`);
      }
    }

    console.log('\n8. Saved reports belong to their owner');
    {
      const definition = { ...base, dimensions: ['category'] };
      const created = await post(baseUrl, '/api/reports/saved', ownerToken, { name: 'Por categoría', definition });
      assertEqual(created.status, 201, 'a valid report is saved');

      const invalid = await post(baseUrl, '/api/reports/saved', ownerToken, {
        name: 'malo',
        definition: { ...base, measures: ['DROP'] },
      });
      assertEqual(invalid.status, 400, 'an invalid definition never reaches the table');
      assertEqual(db.prepare("SELECT COUNT(*) n FROM saved_reports").get().n, 1, 'only the valid one was stored');

      const row = db.prepare('SELECT user_id FROM saved_reports').get() as { user_id: string };
      assertEqual(row.user_id, ownerId, 'the row records who owns it');

      const again = await post(baseUrl, '/api/reports/saved', ownerToken, { name: 'Por categoría', definition });
      assertEqual(again.status, 200, 'saving the same name updates instead of duplicating');
      assertEqual(db.prepare('SELECT COUNT(*) n FROM saved_reports').get().n, 1, 'still one row');
    }

    console.log('\n' + '='.repeat(60));
    console.log(`${passed}/${passed + failed} passed, ${failed} failed`);
  } finally {
    server.close();
    closeDatabase();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
