/**
 * Receivables (fiado) — listing, aging, terms, and collecting
 *
 * What is checked:
 *   · The list holds no balance of its own — it reads `bills.balance` and
 *     never writes it. Collecting goes through the existing bill payment
 *     route, and the receivable disappears once the bill is paid.
 *   · A bill with no due date ages from its own billing date (payable on the
 *     spot); one with a due date ages from there instead.
 *   · The four buckets — current, week, month, overdue — land where the
 *     day count says, in the tenant's own timezone.
 *   · A bill with no customer is not a receivable: there is no one to collect
 *     from.
 *   · A partial payment lowers the balance without erasing the receivable.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/receivables.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-receivables-'));
Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-receivables';

const express = require('express');
const jwt = require('jsonwebtoken');
const { initDatabase, getDatabase, closeDatabase, now, localDateInTimezone } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { receivablesRoutes } = require('../main/routes/receivables');
const { billRoutes } = require('../main/routes/bills');
const { requireModule } = require('../main/services/modules');
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
  if (Math.abs(actual - expected) < 0.005) { passed++; console.log(`  ✓ ${message}`); }
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

function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

async function main() {
  console.log('Receivables (fiado)');
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
  setSetting.run(MODULE_SETTING_KEY.receivables, 'true', stamp);

  for (const [id, role] of [['owner-rc', 'owner'], ['cashier-rc', 'cashier']]) {
    db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(id, role, `${id}@test.local`, 'x', role, stamp, stamp);
  }
  db.prepare(`INSERT INTO categories (id, name, created_at, updated_at) VALUES ('cat-rc', 'Mesas', ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO products (id, category_id, name, price, created_at, updated_at) VALUES ('p-rc', 'cat-rc', 'Almuerzo', 25000, ?, ?)`).run(stamp, stamp);

  const today = localDateInTimezone(new Date(), 'America/Bogota');

  let nextOrderId = 1;
  let nextBillId = 1;
  const seedBill = (opts: {
    customerId: string | null; total: number; paidAmount?: number;
    status?: 'unpaid' | 'partial' | 'paid'; createdAt?: string;
  }) => {
    const orderId = nextOrderId++;
    db.prepare(`INSERT INTO orders (id, order_number, status, subtotal, total, created_at, updated_at)
                VALUES (?, ?, 'active', ?, ?, ?, ?)`)
      .run(orderId, `ORD-${orderId}`, opts.total, opts.total, opts.createdAt ?? stamp, opts.createdAt ?? stamp);
    const billId = nextBillId++;
    const paid = opts.paidAmount ?? 0;
    db.prepare(`
      INSERT INTO bills (id, bill_number, order_id, customer_id, subtotal, total, paid_amount, balance, payment_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      billId, `INV-${billId}`, orderId, opts.customerId, opts.total, opts.total,
      paid, opts.total - paid, opts.status ?? 'unpaid', opts.createdAt ?? stamp, opts.createdAt ?? stamp,
    );
    return billId;
  };

  db.prepare(`INSERT INTO customers (id, name, phone, created_at, updated_at) VALUES ('c-julian', 'Julián Bernal', '3159902214', ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO customers (id, name, phone, created_at, updated_at) VALUES ('c-daniela', 'Daniela Cruz', '3201186654', ?, ?)`).run(stamp, stamp);

  const app = express();
  app.use(express.json());
  app.use((req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) { res.status(401).json({ error: 'Authentication required' }); return; }
    try { req.user = jwt.verify(header.split(' ')[1], getJWTSecret()); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  });
  app.use('/api/receivables', requireModule('receivables'), receivablesRoutes);
  app.use('/api/bills', billRoutes);

  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const tokenFor = (id: string, role: string) =>
    jwt.sign({ userId: id, email: `${id}@test.local`, role }, getJWTSecret(), { expiresIn: '1h' });
  const owner = tokenFor('owner-rc', 'owner');
  const cashier = tokenFor('cashier-rc', 'cashier');

  try {
    // ── 1. No balance of its own ──────────────────────────────────────────
    console.log('\n1. No stored balance');
    const noOne = await call(baseUrl, 'GET', '/api/receivables', owner);
    assertEqual(noOne.status, 200, 'the list responds');
    assertEqual(noOne.data.receivables.length, 0, 'and starts empty');

    // A bill nobody owes: no customer attached. Not a receivable.
    seedBill({ customerId: null, total: 40000 });
    const stillNone = await call(baseUrl, 'GET', '/api/receivables', owner);
    assertEqual(stillNone.data.receivables.length, 0, 'an unpaid bill with no customer is not listed');

    // ── 2. Aging from the billing date, with no due date set ──────────────
    console.log('\n2. Aging without explicit terms');
    const freshBillId = seedBill({ customerId: 'c-julian', total: 54000, createdAt: stamp });
    const listNow = await call(baseUrl, 'GET', '/api/receivables', owner);
    const fresh = listNow.data.receivables.find((r: any) => r.bill_id === freshBillId);
    assert(!!fresh, 'a fiado billed today shows up');
    assertEqual(fresh.age_bucket, 'current', 'billed today, no due date → current (payable on the spot, not yet overdue)');
    assertEqual(fresh.days_overdue, 0, 'zero days overdue');

    const tenDaysAgo = addDays(today, -10);
    const oldBillId = seedBill({ customerId: 'c-daniela', total: 100000, createdAt: `${tenDaysAgo} 12:00:00` });
    const listOld = await call(baseUrl, 'GET', '/api/receivables', owner);
    const old = listOld.data.receivables.find((r: any) => r.bill_id === oldBillId);
    assertEqual(old.age_bucket, 'month', '10 days old, no due date → month bucket (8-30)');
    assertEqual(old.days_overdue, 10, 'ten days overdue');

    // ── 3. Setting terms moves the anchor ─────────────────────────────────
    console.log('\n3. Explicit due date');
    const futureDue = addDays(today, 15);
    const termsFuture = await call(baseUrl, 'PUT', `/api/receivables/${freshBillId}/terms`, owner, { due_date: futureDue });
    assertEqual(termsFuture.status, 200, 'a due date in the future is accepted');
    const afterFuture = await call(baseUrl, 'GET', '/api/receivables', owner);
    const freshAfter = afterFuture.data.receivables.find((r: any) => r.bill_id === freshBillId);
    assertEqual(freshAfter.age_bucket, 'current', 'not yet due → still current, even though it was billed today');
    assertEqual(freshAfter.due_date, futureDue, 'the due date is echoed back');

    const overdueDue = addDays(today, -45);
    await call(baseUrl, 'PUT', `/api/receivables/${oldBillId}/terms`, owner, { due_date: overdueDue, notes: 'Cliente de toda la vida' });
    const afterOverdue = await call(baseUrl, 'GET', '/api/receivables', owner);
    const oldAfter = afterOverdue.data.receivables.find((r: any) => r.bill_id === oldBillId);
    assertEqual(oldAfter.age_bucket, 'overdue', 'due 45 days ago → overdue (30+), even though billed only 10 days ago');
    assertEqual(oldAfter.notes, 'Cliente de toda la vida', 'the note is kept');

    // ── 4. Validation ──────────────────────────────────────────────────────
    console.log('\n4. Validation');
    const badDate = await call(baseUrl, 'PUT', `/api/receivables/${freshBillId}/terms`, owner, { due_date: '15/12/2026' });
    assertEqual(badDate.status, 400, 'a non-ISO date is refused');
    const noBill = await call(baseUrl, 'PUT', '/api/receivables/999999/terms', owner, { due_date: today });
    assertEqual(noBill.status, 404, 'setting terms on a bill that does not exist fails');
    const byCashier = await call(baseUrl, 'PUT', `/api/receivables/${freshBillId}/terms`, cashier, { due_date: today });
    assertEqual(byCashier.status, 403, 'a cashier cannot set terms, only owner/manager');

    // ── 5. Summary totals ──────────────────────────────────────────────────
    console.log('\n5. Summary');
    const summary = (await call(baseUrl, 'GET', '/api/receivables', owner)).data.summary;
    assertClose(summary.total_balance, 54000 + 100000, 'total balance sums every open bill');
    assertClose(summary.overdue_balance, 100000, 'overdue balance counts only non-current buckets');
    assertEqual(summary.customer_count, 2, 'two distinct customers owe money');

    // ── 6. Collecting goes through the existing payment route ────────────
    console.log('\n6. Collecting a payment');
    const partial = await call(baseUrl, 'POST', `/api/bills/${oldBillId}/payment`, cashier, { method: 'cash', amount: '40000' });
    assertEqual(partial.status, 200, 'a cashier can register a partial payment');
    assertEqual(partial.data.bill.payment_status, 'partial', 'the bill moves to partial');

    const afterPartial = await call(baseUrl, 'GET', '/api/receivables', owner);
    const oldStillThere = afterPartial.data.receivables.find((r: any) => r.bill_id === oldBillId);
    assert(!!oldStillThere, 'the receivable is still listed after a partial payment');
    assertClose(oldStillThere.balance, 60000, 'and its balance reflects the payment — read from the bill, not stored here');

    const full = await call(baseUrl, 'POST', `/api/bills/${oldBillId}/payment`, cashier, { method: 'cash' });
    assertEqual(full.status, 200, 'paying the remainder (amount omitted) succeeds');
    assertEqual(full.data.bill.payment_status, 'paid', 'the bill is now fully paid');

    const afterFull = await call(baseUrl, 'GET', '/api/receivables', owner);
    assert(!afterFull.data.receivables.some((r: any) => r.bill_id === oldBillId), 'a paid bill disappears from receivables on its own — no separate deletion needed');
    assertEqual(afterFull.data.receivables.length, 1, 'only the still-open fiado remains');

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
