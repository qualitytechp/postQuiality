/**
 * Schema coverage for staff hard-delete/merge (owner-only, DELETE /api/staff/:id
 * and POST /api/staff/:id/merge).
 *
 * `tests/staff-authz.test.ts` covers the authorization boundaries and the
 * request-validation edge cases end to end with a single representative
 * table. This file targets what that one table can't prove:
 *
 *   1. Every [table, column] in USER_REF_COLUMNS names a column that
 *      actually exists on the live schema — imported directly from
 *      `main/routes/staff.ts` rather than copied here, so this audits the
 *      real list a merge/delete runs against, not a snapshot of it.
 *   2. The two ON DELETE CASCADE columns (station_users.user_id,
 *      saved_reports.user_id) really do get reassigned to the target
 *      *before* the source row is deleted — reverse that order and a merge
 *      would silently wipe the row instead of moving it.
 *   3. A merge that collides with the target's own data (two staff saving a
 *      report under the same name) rolls back cleanly and surfaces as a 409,
 *      not a bare 500 with half the merge applied.
 *
 * Run: npm run test:staff-merge
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-staff-merge-'));
process.env.FLO_AUTH_RATE_LIMIT_MAX = process.env.FLO_AUTH_RATE_LIMIT_MAX || '100';

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const {
  initTestDb, createApp, assert, assertEqual, getResults, closeDatabase, now,
} = require('./helpers/test-setup');
const { staffRoutes, USER_REF_COLUMNS } = require('../main/routes/staff');
const { getJWTSecret } = require('../main/routes/auth');

function seedUser(db: any, id: string, role: string) {
  const email = `${id}@test.local`;
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, id, email, bcrypt.hashSync('Testpass1', 10), role, now(), now());
  const token = jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' });
  return { Authorization: `Bearer ${token}` };
}

async function main() {
  console.log('Staff hard-delete/merge schema coverage');
  console.log('='.repeat(60));

  const db = initTestDb();
  const ownerAuth = seedUser(db, 'schema-owner', 'owner');
  const app = createApp({ '/api/staff': staffRoutes });

  console.log('\n── USER_REF_COLUMNS matches the live schema ──────────────────');
  const tables = new Set<string>();
  for (const [table, column] of USER_REF_COLUMNS as Array<[string, string]>) {
    tables.add(table);
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    assert(columns.includes(column), `${table}.${column} exists on the live schema`);
  }
  assert(tables.size >= 20, `covers a broad swath of the schema (${tables.size} distinct tables)`);
  console.log(`   ✓ all ${(USER_REF_COLUMNS as unknown[]).length} entries across ${tables.size} tables resolve to real columns`);

  console.log('\n── ON DELETE CASCADE columns really get reassigned first ─────');

  // station_users needs a real kitchen_stations row for its own FK.
  db.prepare(`
    INSERT INTO kitchen_stations (id, name, created_at, updated_at)
    VALUES ('station-1', 'Grill', ?, ?)
  `).run(now(), now());

  {
    const source = seedUser(db, 'cascade-source-1', 'cashier');
    const targetAuth = seedUser(db, 'cascade-target-1', 'cashier');
    void source;
    db.prepare(`INSERT INTO station_users (user_id, station_id, created_at) VALUES (?, ?, ?)`)
      .run('cascade-source-1', 'station-1', now());

    const res = await request(app).post('/api/staff/cascade-source-1/merge').set(ownerAuth).send({ merge_into: 'cascade-target-1' });
    assertEqual(res.status, 200, 'merging a user assigned to a kitchen station succeeds');

    const row = db.prepare('SELECT user_id FROM station_users WHERE station_id = ?').get('station-1') as any;
    assert(!!row, 'station_users row survives the merge instead of cascading away with the deleted source');
    assertEqual(row.user_id, 'cascade-target-1', 'the surviving row now points at the target user');
    void targetAuth;
  }

  {
    const targetAuth = seedUser(db, 'cascade-target-2', 'cashier');
    seedUser(db, 'cascade-source-2', 'cashier');
    db.prepare(`
      INSERT INTO saved_reports (id, user_id, name, definition_json, created_at, updated_at)
      VALUES ('report-1', 'cascade-source-2', 'Ventas del mes', '{}', ?, ?)
    `).run(now(), now());

    const res = await request(app).post('/api/staff/cascade-source-2/merge').set(ownerAuth).send({ merge_into: 'cascade-target-2' });
    assertEqual(res.status, 200, 'merging a user with a saved report succeeds');

    const row = db.prepare('SELECT user_id FROM saved_reports WHERE id = ?').get('report-1') as any;
    assert(!!row, 'saved_reports row survives the merge instead of cascading away');
    assertEqual(row.user_id, 'cascade-target-2', 'the surviving report now belongs to the target user');
    void targetAuth;
  }

  console.log('   ✓ station_users and saved_reports rows are reassigned, never cascade-deleted');

  console.log('\n── A conflicting merge rolls back cleanly instead of half-applying ─');
  {
    seedUser(db, 'conflict-source', 'cashier');
    seedUser(db, 'conflict-target', 'cashier');
    db.prepare(`
      INSERT INTO saved_reports (id, user_id, name, definition_json, created_at, updated_at)
      VALUES ('report-source', 'conflict-source', 'Duplicado', '{}', ?, ?)
    `).run(now(), now());
    db.prepare(`
      INSERT INTO saved_reports (id, user_id, name, definition_json, created_at, updated_at)
      VALUES ('report-target', 'conflict-target', 'Duplicado', '{}', ?, ?)
    `).run(now(), now());
    db.prepare(`INSERT INTO station_users (user_id, station_id, created_at) VALUES (?, ?, ?)`)
      .run('conflict-source', 'station-1', now());

    const res = await request(app).post('/api/staff/conflict-source/merge').set(ownerAuth).send({ merge_into: 'conflict-target' });
    assertEqual(res.status, 409, 'a same-named saved report on both sides is refused, not silently overwritten');

    assert(
      !!db.prepare('SELECT 1 FROM users WHERE id = ?').get('conflict-source'),
      'the source user still exists — the whole transaction rolled back',
    );
    const stationRow = db.prepare('SELECT user_id FROM station_users WHERE station_id = ? AND user_id = ?')
      .get('station-1', 'conflict-source') as any;
    assert(
      !!stationRow,
      'the station_users row that WAS successfully reassignable stayed on the source — nothing partially merged',
    );
  }
  console.log('   ✓ a conflicting merge is all-or-nothing');

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
