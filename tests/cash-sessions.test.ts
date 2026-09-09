/**
 * Cash sessions — open/close cycle, shifts, and closure amendments
 *
 * The register is opened with its float and closed with its Z. Only one may be
 * open at a time (a drawer is a physical thing), but several may exist per
 * business date so closing early does not lock the rest of the day.
 *
 * Also covers amending an issued Z: the row keeps its number and its sales
 * snapshot, only the operator-declared amounts change, the variance is
 * recomputed rather than typed, and every change is recorded with its reason.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/cash-sessions.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-cash-sessions-'));
Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-cash-sessions';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { initDatabase, getDatabase, closeDatabase, now, localDateInTimezone } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { cashSessionRoutes } = require('../main/routes/cash-sessions');
const { cashClosureRoutes } = require('../main/routes/cash-closures');

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
  console.log('Cash sessions');
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
  const setSetting = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  setSetting.run('timezone', 'America/Bogota', now());
  setSetting.run('currency', 'COP', now());

  const stamp = now();
  const users: [string, string, string][] = [
    ['owner-cs', 'owner-cs@test.local', 'owner'],
    ['manager-cs', 'manager-cs@test.local', 'manager'],
    ['cashier-cs', 'cashier-cs@test.local', 'cashier'],
    ['server-cs', 'server-cs@test.local', 'server'],
  ];
  for (const [id, email, role] of users) {
    db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(id, role, email, bcrypt.hashSync('password', 10), role, stamp, stamp);
  }

  const app = express();
  app.use(express.json());
  app.use((req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) { res.status(401).json({ error: 'Authentication required' }); return; }
    try { req.user = jwt.verify(header.split(' ')[1], getJWTSecret()); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  });
  app.use('/api/cash-sessions', cashSessionRoutes);
  app.use('/api/cash-closures', cashClosureRoutes);

  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const tokenFor = (id: string, role: string) =>
    jwt.sign({ userId: id, email: `${id}@test.local`, role }, getJWTSecret(), { expiresIn: '1h' });
  const owner = tokenFor('owner-cs', 'owner');
  const manager = tokenFor('manager-cs', 'manager');
  const cashier = tokenFor('cashier-cs', 'cashier');
  const waiter = tokenFor('server-cs', 'server');

  const businessDate = localDateInTimezone(new Date(), 'America/Bogota');

  try {
    console.log('\n1. Who may open the register');
    {
      const refused = await call(baseUrl, 'POST', '/api/cash-sessions', waiter, { opening_float_cents: 1000 });
      assertEqual(refused.status, 403, 'a waiter cannot open the register');

      const opened = await call(baseUrl, 'POST', '/api/cash-sessions', cashier, { opening_float_cents: 50000 });
      assertEqual(opened.status, 201, 'a cashier can open it');
      assertEqual(opened.data.session.opening_float_cents, 50000, 'the declared float is recorded');
      assertEqual(opened.data.session.opened_by, 'cashier-cs', 'and who opened it');
    }

    console.log('\n2. Only one register open at a time');
    {
      const second = await call(baseUrl, 'POST', '/api/cash-sessions', manager, { opening_float_cents: 1000 });
      assertEqual(second.status, 409, 'a second open is refused while one is running');

      const current = await call(baseUrl, 'GET', '/api/cash-sessions/current', waiter);
      assertEqual(current.status, 200, 'any staff member may read the open register');
      assert(current.data.session !== null, 'and sees the one that is open');
    }

    console.log('\n3. Closing takes the float from the opening, not from the request');
    {
      const refused = await call(baseUrl, 'POST', '/api/cash-closures', cashier, {
        business_date: businessDate, opening_float_cents: 0, counted_cash_cents: 50000,
      });
      assertEqual(refused.status, 403, 'a cashier cannot close');

      const closed = await call(baseUrl, 'POST', '/api/cash-closures', owner, {
        business_date: businessDate,
        // Deliberately wrong: the session's float must win.
        opening_float_cents: 999,
        counted_cash_cents: 50000,
      });
      assertEqual(closed.status, 201, 'the owner closes the shift');
      assertEqual(closed.data.zReport.scope, 'session', 'the Z is scoped to the shift, not the day');
      assertEqual(closed.data.zReport.opening_float_cents, 50000, 'the float comes from the opening');
      assertEqual(closed.data.zReport.expected_cash_cents, 50000, 'expected = float + no sales');
      assertEqual(closed.data.zReport.variance_cents, 0, 'counting the float back gives no variance');

      const session = db.prepare('SELECT closed_at, closure_id FROM cash_sessions WHERE id = 1').get() as any;
      assert(!!session.closed_at, 'the session is closed');
      assertEqual(session.closure_id, closed.data.zReport.id, 'and linked to its Z');

      const after = await call(baseUrl, 'GET', '/api/cash-sessions/current', owner);
      assertEqual(after.data.session, null, 'no register is open afterwards');
    }

    console.log('\n4. A second shift on the same day is allowed');
    {
      const reopened = await call(baseUrl, 'POST', '/api/cash-sessions', manager, { opening_float_cents: 20000 });
      assertEqual(reopened.status, 201, 'the register opens again the same day');

      const closed = await call(baseUrl, 'POST', '/api/cash-closures', owner, {
        business_date: businessDate, opening_float_cents: 0, counted_cash_cents: 20000,
      });
      assertEqual(closed.status, 201, 'and closes again — a same-day close is no longer blocked');
      assertEqual(closed.data.zReport.opening_float_cents, 20000, 'with its own float');

      const zNumbers = db.prepare('SELECT z_number FROM cash_closures ORDER BY z_number').all() as any[];
      assertEqual(zNumbers.length, 2, 'two Z reports exist for the day');
      assert(zNumbers[0].z_number !== zNumbers[1].z_number, 'each has its own number');

      const sessions = await call(baseUrl, 'GET', `/api/cash-sessions?date=${businessDate}`, owner);
      assertEqual(sessions.data.sessions.length, 2, 'both shifts are listed for the date');
    }

    console.log('\n5. Amending an issued Z keeps the trail');
    {
      const target = db.prepare('SELECT id, z_number FROM cash_closures ORDER BY id LIMIT 1').get() as any;

      const noReason = await call(baseUrl, 'PUT', `/api/cash-closures/${target.id}`, owner, {
        counted_cash_cents: 45000,
      });
      assertEqual(noReason.status, 400, 'an amendment without a reason is refused');

      const byManager = await call(baseUrl, 'PUT', `/api/cash-closures/${target.id}`, manager, {
        counted_cash_cents: 45000, reason: 'x',
      });
      assertEqual(byManager.status, 403, 'only the owner may amend');

      const amended = await call(baseUrl, 'PUT', `/api/cash-closures/${target.id}`, owner, {
        counted_cash_cents: 45000,
        reason: 'Faltaron 5.000 al recontar',
      });
      assertEqual(amended.status, 200, 'the owner amends it');
      assertEqual(amended.data.closure.counted_cash_cents, 45000, 'the count is updated');
      assertEqual(amended.data.closure.variance_cents, -5000, 'the variance is recomputed, not typed');
      assertEqual(amended.data.closure.z_number, target.z_number, 'the Z number never changes');
      assert(Array.isArray(amended.data.closure.payment_methods),
        'the response keeps the full snapshot shape the ticket needs');

      const trail = await call(baseUrl, 'GET', `/api/cash-closures/${target.id}/amendments`, owner);
      assertEqual(trail.status, 200, 'the trail is readable');
      assertEqual(trail.data.amendments.length, 2, 'both changed fields are recorded');
      const counted = trail.data.amendments.find((a: any) => a.field === 'counted_cash_cents');
      assertEqual(counted.old_value, '50000', 'the old value is kept');
      assertEqual(counted.new_value, '45000', 'alongside the new one');
      assertEqual(counted.amended_by, 'owner-cs', 'and who made the change');
      assert(String(counted.reason).length > 0, 'and why');

      const unchanged = await call(baseUrl, 'PUT', `/api/cash-closures/${target.id}`, owner, {
        counted_cash_cents: 45000, reason: 'sin cambios',
      });
      assertEqual(unchanged.status, 400, 'an amendment that changes nothing is refused');
    }

    console.log('\n6. Sales are not required to be recomputed by an amendment');
    {
      const row = db.prepare('SELECT gross_collected_cents, bill_count FROM cash_closures ORDER BY id LIMIT 1').get() as any;
      assertEqual(row.gross_collected_cents, 0, 'the sales snapshot is untouched by the amendment');
      assertEqual(row.bill_count, 0, 'and so is the bill count');
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
