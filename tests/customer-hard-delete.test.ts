/**
 * Regression coverage for DELETE /api/customers/:id (owner-only, permanent).
 *
 * Mirrors the staff hard-delete pattern (tests/staff-authz.test.ts +
 * tests/staff-merge.test.ts): a customer is only ever removed when the
 * schema has zero real references to it, and the reference list itself is
 * audited against the live schema rather than trusted at face value — a
 * hallucinated or stale [table, column] entry would crash the very first
 * delete attempt with "no such column".
 *
 * Run: npm run test:customer-hard-delete
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-customer-hard-delete-'));
process.env.FLO_AUTH_RATE_LIMIT_MAX = process.env.FLO_AUTH_RATE_LIMIT_MAX || '100';

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const request = require('supertest');
const {
  initTestDb, createApp, seedOwnerUser, seedManagerUser, assert, assertEqual, getResults, closeDatabase, now,
} = require('./helpers/test-setup');
const { customerRoutes, CUSTOMER_REF_COLUMNS } = require('../main/routes/customers');

async function main() {
  console.log('Customer hard-delete regression tests');
  console.log('='.repeat(60));

  const db = initTestDb();
  const { authHeader: ownerAuth } = seedOwnerUser(db);
  const { authHeader: managerAuth } = seedManagerUser(db);
  const app = createApp({ '/api/customers': customerRoutes });

  const createCustomer = async (name: string) => {
    const res = await request(app).post('/api/customers').set(ownerAuth).send({ name });
    return res.body.customer.id as string;
  };

  console.log('\n── CUSTOMER_REF_COLUMNS matches the live schema ───────────────');
  for (const [table, column] of CUSTOMER_REF_COLUMNS as Array<[string, string]>) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    assert(columns.includes(column), `${table}.${column} exists on the live schema`);
  }
  console.log(`   ✓ all ${(CUSTOMER_REF_COLUMNS as unknown[]).length} entries resolve to real columns`);

  console.log('\n── Happy path ───────────────────────────────────────────────');
  {
    const id = await createCustomer('No Movements');
    const res = await request(app).delete(`/api/customers/${id}`).set(ownerAuth);
    assertEqual(res.status, 200, 'owner can permanently delete a customer with zero references');
    assertEqual(res.body.deletedId, id, 'delete response echoes the deleted id');
    assert(!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(id), 'the row is actually gone');
  }

  console.log('\n── Authorization ────────────────────────────────────────────');
  {
    const id = await createCustomer('Manager Cannot Touch');
    const res = await request(app).delete(`/api/customers/${id}`).set(managerAuth);
    assertEqual(res.status, 403, 'manager cannot permanently delete a customer');
    assert(!!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(id), 'the row survives a forbidden attempt');
  }
  {
    const res = await request(app).delete('/api/customers/does-not-exist').set(ownerAuth);
    assertEqual(res.status, 404, 'deleting a nonexistent customer 404s');
  }

  console.log('\n── Blocked by real activity ─────────────────────────────────');
  {
    const id = await createCustomer('Has An Order');
    db.prepare(`INSERT INTO orders (order_number, customer_id, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run('ORD-HD-1', id, now(), now());
    const res = await request(app).delete(`/api/customers/${id}`).set(ownerAuth);
    assertEqual(res.status, 409, 'cannot permanently delete a customer with an order on record');
    assert(res.body.referencingTables?.includes('orders.customer_id'), 'the 409 body names the referencing table');
    assert(!!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(id), 'the row survives a refused delete');
  }
  {
    const id = await createCustomer('Has A Held Order');
    db.prepare(`INSERT INTO held_orders (id, table_id, items, customer_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('held-hd-1', 'table-1', '[]', id, now(), now());
    const res = await request(app).delete(`/api/customers/${id}`).set(ownerAuth);
    assertEqual(res.status, 409, 'cannot permanently delete a customer with a held order on record');
    assert(res.body.referencingTables?.includes('held_orders.customer_id'), 'the 409 body names held_orders');
  }
  {
    // whatsapp_messages.customer_id is FK-enforced (no ON DELETE clause) — this
    // proves the friendly 409 fires before the raw SQLite constraint would.
    const id = await createCustomer('Has A WhatsApp Message');
    db.prepare(`
      INSERT INTO whatsapp_messages (customer_id, phone_e164, direction, body, queued_at)
      VALUES (?, ?, 'outbound', 'Hello', ?)
    `).run(id, '+15551234567', now());
    const res = await request(app).delete(`/api/customers/${id}`).set(ownerAuth);
    assertEqual(res.status, 409, 'cannot permanently delete a customer with a WhatsApp message on record');
    assert(res.body.referencingTables?.includes('whatsapp_messages.customer_id'), 'the 409 body names whatsapp_messages');
  }

  const { passed, failed, total } = getResults();
  console.log('\n' + '='.repeat(60));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main()
  .then(() => {})
  .catch((error) => {
    console.error('Test crashed:', error);
    process.exit(1);
  })
  .finally(() => {
    try { closeDatabase(); } catch { /* already closed */ }
    Module._load = originalLoad;
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  });

// Top-level export: makes this a module, not a global script, so its
// boilerplate names stop colliding with every other script-style test file
// under tsc's whole-project view. No import consumers; harmless at runtime.
export {};
