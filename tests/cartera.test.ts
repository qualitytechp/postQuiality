/**
 * Cartera y Tesorería — accounts, movements, payables, and the drawer
 *
 * What is checked:
 *   · No account stores a balance. A bank account's balance is its opening
 *     figure plus what came in and out; the cash account mirrors the drawer's
 *     own open/close cycle instead of keeping a second number for the till.
 *   · A collection taken at the POS lands in the account bound to that payment
 *     method, without Cartera writing anything.
 *   · Cash never moves with the register closed — an expense or a transfer out
 *     of the drawer is refused, because it would belong to no Z report.
 *   · Manual cash movements change the expected cash on the close screen by
 *     exactly what they moved, so the drawer and the report agree.
 *   · A transfer is two legs of one movement; voiding either voids both.
 *   · Payables take instalments: an abono lowers the balance and leaves the
 *     rest outstanding, and overpaying is refused.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/cartera.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-cartera-'));
Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-cartera';

const express = require('express');
const jwt = require('jsonwebtoken');
const { initDatabase, getDatabase, closeDatabase, now, localDateInTimezone } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { carteraRoutes } = require('../main/routes/cartera');
const { requireModule } = require('../main/services/modules');
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
  console.log('Cartera y Tesorería');
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

  for (const [id, role] of [['owner-ct', 'owner'], ['cashier-ct', 'cashier']]) {
    db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(id, role, `${id}@test.local`, 'x', role, stamp, stamp);
  }

  const today = localDateInTimezone(new Date(), 'America/Bogota');

  const app = express();
  app.use(express.json());
  app.use((req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) { res.status(401).json({ error: 'Authentication required' }); return; }
    try { req.user = jwt.verify(header.split(' ')[1], getJWTSecret()); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  });
  app.use('/api/cartera', requireModule('receivables'), carteraRoutes);

  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const owner = jwt.sign({ userId: 'owner-ct', email: 'owner-ct@test.local', role: 'owner' }, getJWTSecret(), { expiresIn: '1h' });

  const accountsNow = async () => (await call(baseUrl, 'GET', '/api/cartera/accounts', owner)).data.accounts;
  const findAccount = async (name: string) => (await accountsNow()).find((a: any) => a.name === name);

  try {
    // ── 1. The drawer exists from the start ──────────────────────────────
    console.log('\n1. The cash account');
    const initial = await accountsNow();
    assertEqual(initial.length, 1, 'a fresh database has exactly one account');
    assertEqual(initial[0].kind, 'cash', 'and it is the drawer');
    assertEqual(initial[0].canonical_method, 'cash', 'bound to the cash payment method');
    assertEqual(initial[0].balance_cents, 0, 'starting at zero with no register history');

    const secondCash = await call(baseUrl, 'POST', '/api/cartera/accounts', owner, { name: 'Otra caja', kind: 'cash' });
    assertEqual(secondCash.status, 400, 'a second cash account is refused — there is one physical drawer');

    // ── 2. A bank account and what lands in it ───────────────────────────
    console.log('\n2. A bank account');
    db.prepare(`INSERT INTO payment_methods (id, name, is_active, sort_order) VALUES (7, 'Nequi', 1, 10)`).run();
    const nequi = await call(baseUrl, 'POST', '/api/cartera/accounts', owner, {
      name: 'Nequi', kind: 'digital', payment_method_id: 7,
      opening_balance_cents: 100000, opening_as_of: addDays(today, -30),
    });
    assertEqual(nequi.status, 201, 'a digital account bound to a merchant payment method is created');

    const duplicate = await call(baseUrl, 'POST', '/api/cartera/accounts', owner, {
      name: 'Nequi 2', kind: 'digital', payment_method_id: 7,
    });
    assertEqual(duplicate.status, 409, 'two accounts cannot claim the same payment method');

    const bothBindings = await call(baseUrl, 'POST', '/api/cartera/accounts', owner, {
      name: 'Confuso', kind: 'bank', payment_method_id: 7, canonical_method: 'card',
    });
    assertEqual(bothBindings.status, 400, 'an account binds to one payment method, not two');

    // A sale settled through Nequi: Cartera writes nothing, it reads the bill.
    db.prepare(`INSERT INTO orders (id, order_number, status, subtotal, total, created_at, updated_at)
                VALUES (1, 'ORD-1', 'completed', 60000, 60000, ?, ?)`).run(stamp, stamp);
    db.prepare(`
      INSERT INTO bills (id, bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
      VALUES (1, 'INV-1', 1, 60000, 60000, 60000, 0, 'paid', ?, ?, ?, ?)
    `).run(JSON.stringify([{ method: 'Nequi', payment_method_id: 7, amount: 60000, timestamp: stamp }]), stamp, stamp, stamp);

    const withSale = await findAccount('Nequi');
    assertEqual(withSale.balance_cents, 160000, 'the opening balance plus the collection, with nothing copied');
    assertEqual(withSale.inflow_cents, 60000, 'the collection is counted as an inflow');

    // ── 3. Cash needs an open register ────────────────────────────────────
    console.log('\n3. Cash with the register closed');
    const cash = await findAccount('Caja');
    const blockedExpense = await call(baseUrl, 'POST', '/api/cartera/movements', owner, {
      account_id: cash.id, kind: 'expense', amount_cents: 45000, concept: 'Aseo y cafetería',
    });
    assertEqual(blockedExpense.status, 409, 'a cash expense is refused while the drawer is closed');

    const bankIncome = await call(baseUrl, 'POST', '/api/cartera/movements', owner, {
      account_id: withSale.id, kind: 'income', amount_cents: 25000, concept: 'Reembolso proveedor',
    });
    assertEqual(bankIncome.status, 201, 'a bank movement needs no register at all');
    assertEqual((await findAccount('Nequi')).balance_cents, 185000, 'and it raises that account');

    // ── 4. With the register open ────────────────────────────────────────
    console.log('\n4. With the register open');
    db.prepare(`INSERT INTO cash_sessions (business_date, opening_float_cents, opened_by, opened_at)
                VALUES (?, 320000, 'owner-ct', ?)`).run(today, stamp);

    const expense = await call(baseUrl, 'POST', '/api/cartera/movements', owner, {
      account_id: cash.id, kind: 'expense', amount_cents: 45000, concept: 'Aseo y cafetería',
    });
    assertEqual(expense.status, 201, 'now the cash expense is accepted');

    const income = await call(baseUrl, 'POST', '/api/cartera/movements', owner, {
      account_id: cash.id, kind: 'income', amount_cents: 18000, concept: 'Venta de cajas vacías',
    });
    assertEqual(income.status, 201, 'and so is a cash income');

    const cashAfter = await findAccount('Caja');
    assertEqual(cashAfter.balance_cents, 320000 - 45000 + 18000, 'the drawer reads float minus expense plus income');

    // The register's own figure has to move by the same amount.
    const aggregates = computeDayAggregates(db, today);
    assertEqual(aggregates.carteraCashOutCents, 45000, 'the close screen sees the cash that left');
    assertEqual(aggregates.carteraCashInCents, 18000, 'and the cash that came in');

    // ── 4b. The drawer cannot hand out what it does not hold ─────────────
    console.log('\n4b. Overdrawing the drawer');
    const overdraw = await call(baseUrl, 'POST', '/api/cartera/movements', owner, {
      account_id: cash.id, kind: 'expense', amount_cents: 9_000_000, concept: 'Compra de local',
    });
    assertEqual(overdraw.status, 409, 'an expense larger than the cash on hand is refused');
    assertEqual((await findAccount('Caja')).balance_cents, 320000 - 45000 + 18000, 'and the drawer is untouched');

    const overTransfer = await call(baseUrl, 'POST', '/api/cartera/transfers', owner, {
      from_account_id: cash.id, to_account_id: withSale.id, amount_cents: 9_000_000,
    });
    assertEqual(overTransfer.status, 409, 'so is a transfer that would empty it past zero');

    // A bank account is not a drawer: an overdraft there is the bank's
    // business, not something this module should pretend to know about.
    const bankOverdraft = await call(baseUrl, 'POST', '/api/cartera/movements', owner, {
      account_id: withSale.id, kind: 'expense', amount_cents: 9_000_000, concept: 'Pago grande',
    });
    assertEqual(bankOverdraft.status, 201, 'a bank account may go negative — that is between the merchant and the bank');
    await call(baseUrl, 'POST', `/api/cartera/movements/${bankOverdraft.data.id}/void`, owner, { reason: 'Prueba' });

    // ── 5. Transfers are one movement with two legs ──────────────────────
    console.log('\n5. Transfers');
    const transfer = await call(baseUrl, 'POST', '/api/cartera/transfers', owner, {
      from_account_id: cash.id, to_account_id: withSale.id, amount_cents: 100000,
      concept: 'Consignación desde caja',
    });
    assertEqual(transfer.status, 201, 'the transfer is recorded');
    assertEqual((await findAccount('Caja')).balance_cents, 320000 - 45000 + 18000 - 100000, 'it left the drawer');
    assertEqual((await findAccount('Nequi')).balance_cents, 285000, 'and arrived in the other account');

    const legs = db.prepare(`SELECT * FROM cartera_entries WHERE transfer_group_id = ?`).all(transfer.data.group_id) as any[];
    assertEqual(legs.length, 2, 'a transfer is two rows');
    assertEqual(legs[0].amount_cents, legs[1].amount_cents, 'of the same amount');
    assert(legs.some((l) => l.direction === 'out') && legs.some((l) => l.direction === 'in'), 'one out, one in');

    const voidLeg = await call(baseUrl, 'POST', `/api/cartera/movements/${legs[0].id}/void`, owner, { reason: 'Se digitó mal' });
    assertEqual(voidLeg.status, 200, 'voiding one leg succeeds');
    const afterVoid = db.prepare(`SELECT COUNT(*) AS n FROM cartera_entries WHERE transfer_group_id = ? AND voided_at IS NOT NULL`)
      .get(transfer.data.group_id) as { n: number };
    assertEqual(afterVoid.n, 2, 'and takes the other leg with it — half a transfer is not a thing');
    assertEqual((await findAccount('Caja')).balance_cents, 320000 - 45000 + 18000, 'the drawer is back where it was');

    const noReason = await call(baseUrl, 'POST', `/api/cartera/movements/${legs[1].id}/void`, owner, {});
    assertEqual(noReason.status, 409, 'an already-void movement cannot be voided again');

    // ── 6. General payables take instalments ─────────────────────────────
    console.log('\n6. Payables and abonos');
    const payable = await call(baseUrl, 'POST', '/api/cartera/payables', owner, {
      payee_name: 'Servicios públicos', concept: 'Energía agosto', reference: 'G-120',
      total_cents: 385000, due_date: addDays(today, 5),
    });
    assertEqual(payable.status, 201, 'a general payable is created');
    assert(/^GAS-\d{8}-\d{4}$/.test(payable.data.payable_number), `numbered ${payable.data.payable_number}`);

    const overdue = await call(baseUrl, 'POST', '/api/cartera/payables', owner, {
      payee_name: 'Inmobiliaria Roble', concept: 'Arriendo local', total_cents: 900000, due_date: addDays(today, -9),
    });
    assertEqual(overdue.status, 201, 'an overdue payable is created');

    const list = await call(baseUrl, 'GET', '/api/cartera/payables', owner);
    assertEqual(list.data.payables.length, 2, 'both show in the list');
    assertEqual(list.data.summary.total_balance_cents, 385000 + 900000, 'the total is what is still owed');
    assertEqual(list.data.payables[0].age_bucket, 'month', 'nine days late lands in the 8-30 bucket');
    assertEqual(list.data.payables[0].days_overdue, 9, 'and says how many days');

    const abono = await call(baseUrl, 'POST', `/api/cartera/payables/general/${payable.data.id}/pay`, owner, {
      account_id: withSale.id, amount_cents: 85000,
    });
    assertEqual(abono.status, 200, 'a partial payment is accepted');
    assertEqual(abono.data.balance_cents, 300000, 'and leaves the rest outstanding');

    const tooMuch = await call(baseUrl, 'POST', `/api/cartera/payables/general/${payable.data.id}/pay`, owner, {
      account_id: withSale.id, amount_cents: 999999,
    });
    assertEqual(tooMuch.status, 400, 'paying more than what is owed is refused');

    const settle = await call(baseUrl, 'POST', `/api/cartera/payables/general/${payable.data.id}/pay`, owner, {
      account_id: withSale.id,
    });
    assertEqual(settle.status, 200, 'paying with no amount settles the remainder');
    assertEqual(settle.data.balance_cents, 0, 'leaving nothing owed');

    const afterSettle = await call(baseUrl, 'GET', '/api/cartera/payables', owner);
    assertEqual(afterSettle.data.payables.length, 1, 'a settled payable drops off the list on its own');

    // ── 7. Movements bring the sources together ──────────────────────────
    console.log('\n7. The movements list');
    const movements = (await call(baseUrl, 'GET', '/api/cartera/movements', owner)).data.movements;
    const types = new Set(movements.map((m: any) => m.type));
    assert(types.has('collection'), 'POS collections appear');
    assert(types.has('expense'), 'manual expenses appear');
    assert(types.has('payable_payment'), 'payments against a payable appear');
    assert(types.has('transfer'), 'transfer legs appear');
    const collection = movements.find((m: any) => m.type === 'collection');
    assertEqual(collection.account_name, 'Nequi', 'a collection is filed under the account its method feeds');
    assertEqual(collection.in_cents, 60000, 'with the amount off the bill');

    // ── 8. The summary agrees with the tabs ──────────────────────────────
    console.log('\n8. Summary');
    const summary = (await call(baseUrl, 'GET', '/api/cartera/summary', owner)).data;
    const accounts = await accountsNow();
    const sumOfAccounts = accounts.reduce((sum: number, a: any) => sum + a.balance_cents, 0);
    assertEqual(summary.available.total_cents, sumOfAccounts, 'available total equals the accounts it lists');
    assertEqual(summary.payables.total_cents, 900000, 'payables match the payables tab');
    assertEqual(summary.register.open, true, 'the register card knows the drawer is open');
    assertEqual(
      summary.register.expected_cash_cents,
      accounts.find((a: any) => a.kind === 'cash').balance_cents,
      'and its expected cash is the same figure the cash account shows',
    );
    assertEqual(
      summary.net_position_cents,
      summary.available.total_cents + summary.receivables.total_cents - summary.payables.total_cents,
      'net position is available plus owed to us minus what we owe',
    );

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
