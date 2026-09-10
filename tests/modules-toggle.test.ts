/**
 * Optional modules — the on/off contract
 *
 * Turning a module off has to mean something exact, or the flag becomes a
 * scattering of `if`s that nobody can reason about. What is checked here:
 *
 *   · Off by default, so a store that upgrades sees exactly what it saw before.
 *   · A gated route answers 403 while the module is off, and says which module,
 *     so the interface can tell "turned off" from "route does not exist".
 *   · The check is per request: flipping the setting takes effect without a
 *     restart, because the routes are always mounted and the gate decides.
 *   · Off, then on, then off again leaves the rows untouched. Turning a module
 *     off hides it; it never resolves or deletes anything.
 *   · A non-boolean value is refused rather than silently falling back to the
 *     default, which would leave the switch saying one thing and the backend
 *     doing another.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/modules-toggle.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-modules-toggle-'));
Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-modules-toggle';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { moduleRoutes } = require('../main/routes/modules');
const { requireModule, isModuleEnabled, getModuleStates } = require('../main/services/modules');
const { settingsRoutes } = require('../main/routes/settings');
const {
  OPTIONAL_MODULES, MODULE_SETTING_KEY, MODULE_DEFAULT, allModulesOff,
} = require('../shared/modules');

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
  console.log('Optional modules — on/off contract');
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
  for (const [id, role] of [['owner-mt', 'owner'], ['cashier-mt', 'cashier']]) {
    db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(id, role, `${id}@test.local`, bcrypt.hashSync('password', 10), role, stamp, stamp);
  }

  const app = express();
  app.use(express.json());
  app.use((req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) { res.status(401).json({ error: 'Authentication required' }); return; }
    try { req.user = jwt.verify(header.split(' ')[1], getJWTSecret()); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  });
  app.use('/api/modules', moduleRoutes);
  app.use('/api/settings', settingsRoutes);

  // Stand-in for a real module's routes: the gate is what is under test, not
  // whatever the module happens to do once it is allowed through.
  app.use('/api/gated-purchases', requireModule('purchases'), (_req: any, res: any) => {
    res.json({ reached: true });
  });

  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const tokenFor = (id: string, role: string) =>
    jwt.sign({ userId: id, email: `${id}@test.local`, role }, getJWTSecret(), { expiresIn: '1h' });
  const owner = tokenFor('owner-mt', 'owner');
  const cashier = tokenFor('cashier-mt', 'cashier');

  const setFlag = (module: string, value: string) =>
    call(baseUrl, 'PUT', `/api/settings/${MODULE_SETTING_KEY[module]}`, owner, { value });

  try {
    // ── 1. Every module ships off ────────────────────────────────────────
    console.log('\n1. Off by default');
    for (const module of OPTIONAL_MODULES) {
      assertEqual(MODULE_DEFAULT[module], false, `${module} defaults to off`);
      assertEqual(isModuleEnabled(module), false, `${module} reads as off on a fresh database`);
      const stored = db.prepare('SELECT value FROM settings WHERE key = ?').get(MODULE_SETTING_KEY[module]);
      assert(stored === undefined, `${module} needs no seeded settings row to be off`);
    }
    const off = allModulesOff();
    assertEqual(Object.keys(off).length, OPTIONAL_MODULES.length, 'allModulesOff covers every module');

    // ── 2. /api/modules answers while everything is off ──────────────────
    console.log('\n2. /api/modules answers with everything off');
    const initial = await call(baseUrl, 'GET', '/api/modules', cashier);
    assertEqual(initial.status, 200, 'any signed-in staff member may ask what is on');
    for (const module of OPTIONAL_MODULES) {
      assertEqual(initial.data.modules[module], false, `${module} reported off`);
    }

    // ── 3. A gated route refuses, and says why ───────────────────────────
    console.log('\n3. Gated route while off');
    const blocked = await call(baseUrl, 'GET', '/api/gated-purchases', owner);
    assertEqual(blocked.status, 403, 'gated route answers 403, not 404 or 500');
    assertEqual(blocked.data.module, 'purchases', 'the response names the module');
    assertEqual(blocked.data.enabled, false, 'the response says it is disabled');

    // ── 4. Flipping the switch takes effect without a restart ────────────
    console.log('\n4. Turning it on');
    const turnedOn = await setFlag('purchases', 'true');
    assertEqual(turnedOn.status, 200, 'the switch is writable through the settings route');
    assertEqual(isModuleEnabled('purchases'), true, 'the gate sees the change immediately');
    const allowed = await call(baseUrl, 'GET', '/api/gated-purchases', owner);
    assertEqual(allowed.status, 200, 'the gated route now answers — no restart needed');
    assertEqual(allowed.data.reached, true, 'the request reaches the handler');

    // Modules never require one another: turning one on leaves the rest alone.
    const states = getModuleStates();
    assertEqual(states.purchases, true, 'purchases on');
    assertEqual(states.receivables, false, 'receivables untouched by the other switch');

    // ── 5. Off again leaves the data alone ───────────────────────────────
    console.log('\n5. Turning it off does not delete anything');
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('modules_test_marker', 'kept', ?)`).run(now());
    await setFlag('purchases', 'false');
    assertEqual(isModuleEnabled('purchases'), false, 'the module reads as off again');
    const blockedAgain = await call(baseUrl, 'GET', '/api/gated-purchases', owner);
    assertEqual(blockedAgain.status, 403, 'the gated route is closed again');
    const marker = db.prepare(`SELECT value FROM settings WHERE key = 'modules_test_marker'`).get() as any;
    assertEqual(marker?.value, 'kept', 'rows written while the module was on survive turning it off');

    // ── 6. A garbage value is refused, not silently defaulted ────────────
    console.log('\n6. Only booleans are accepted');
    const garbage = await setFlag('purchases', 'maybe');
    assertEqual(garbage.status, 400, 'a non-boolean value is rejected');
    assertEqual(isModuleEnabled('purchases'), false, 'the rejected write did not change the flag');

    // ── 7. Only owner and manager may flip it ────────────────────────────
    console.log('\n7. Who may flip it');
    const byCashier = await call(baseUrl, 'PUT', `/api/settings/${MODULE_SETTING_KEY.purchases}`, cashier, { value: 'true' });
    assertEqual(byCashier.status, 403, 'a cashier cannot turn a module on');
    assertEqual(isModuleEnabled('purchases'), false, 'and the flag stayed off');

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
