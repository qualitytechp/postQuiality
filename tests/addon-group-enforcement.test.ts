/**
 * Addon Group Enforcement
 *
 * Add-on group selection rules are backend-authoritative: the API must reject
 * an order that violates them even when the client never opened the modal.
 * Covers required groups, min/max selection, single-quantity groups (including
 * a selection split across duplicate entries), deactivated groups and add-ons,
 * product linkage, price authority and the historical snapshot.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/addon-group-enforcement.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-addon-probe-'));
const mockApp = {
  isPackaged: true,
  getPath: () => testDir,
  getVersion: () => 'test',
};

Module._load = function (request: string) {
  if (request === 'electron') return { app: mockApp };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-addon-probe';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { orderRoutes } = require('../main/routes/orders');

let passed = 0;
let failed = 0;

function assertEqual(actual: any, expected: any, message: string) {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function report(label: string, status: number, data: any) {
  console.log(`    → HTTP ${status} ${JSON.stringify(data).slice(0, 160)}   [${label}]`);
}

async function listen(app: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('error', reject);
    server.once('listening', () => resolve(server));
  });
}

async function request(baseUrl: string, urlPath: string, options: Record<string, any> = {}) {
  const fetchOptions: any = { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } };
  if (options.method) fetchOptions.method = options.method;
  if (options.body) fetchOptions.body = options.body;
  const response = await (globalThis as any).fetch(baseUrl + urlPath, fetchOptions);
  const data = await response.json();
  return { status: response.status, data };
}

function isNativeAbiMismatch(error: any): boolean {
  return error?.code === 'ERR_DLOPEN_FAILED' && String(error?.message || '').includes('NODE_MODULE_VERSION');
}

async function main() {
  console.log('Addon Group Enforcement');
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
  const ownerId = 'owner-addon-probe';
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(ownerId, 'Owner', 'owner-probe@test.local', bcrypt.hashSync('password', 10), 'owner', 1, now(), now());

  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)`).run('cat-pizza', 'Pizza', 1);
  db.prepare(
    `INSERT INTO products (id, category_id, name, price, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
  ).run('prod-pizza', 'cat-pizza', 'Pizza Tres Carnes', 38000, 1, 1);
  db.prepare(
    `INSERT INTO products (id, category_id, name, price, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
  ).run('prod-coffee', 'cat-pizza', 'Coffee', 5000, 1, 2);

  // Mirrors the merchant's real setup from the screenshots.
  // "Tamaño de Pizza": REQUIRED, exactly 1 of 3.
  db.prepare(
    `INSERT INTO addon_groups (id, name, is_required, min_selection, max_selection, allow_multiple_quantities, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('ag-size', 'Tamaño de Pizza', 1, 1, 1, 0, 1);
  // "Adiciones para Pizza": optional, up to 5, multi-qty allowed.
  db.prepare(
    `INSERT INTO addon_groups (id, name, is_required, min_selection, max_selection, allow_multiple_quantities, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('ag-extras', 'Adiciones para Pizza', 0, 0, 5, 1, 1);
  // A deactivated group that is still linked to the product.
  db.prepare(
    `INSERT INTO addon_groups (id, name, is_required, min_selection, max_selection, allow_multiple_quantities, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('ag-retired', 'Grupo Retirado', 0, 0, 3, 0, 0);

  const addons: [string, string, string, number, number][] = [
    ['addon-personal', 'ag-size', 'Personal', 0, 1],
    ['addon-mediana', 'ag-size', 'Mediana', 6000, 1],
    ['addon-familiar', 'ag-size', 'Familiar', 12000, 1],
    ['addon-queso', 'ag-extras', 'Queso Mozzarella Extra', 4000, 1],
    ['addon-tocineta', 'ag-extras', 'Tocineta Crujiente Extra', 4500, 1],
    ['addon-champinon', 'ag-extras', 'Champiñones Frescos', 3500, 1],
    ['addon-inactivo', 'ag-extras', 'Adición Descontinuada', 9000, 0],
    ['addon-retirado', 'ag-retired', 'Adición de Grupo Retirado', 7000, 1],
  ];
  for (const [id, group, name, price, active] of addons) {
    db.prepare(
      `INSERT INTO addons (id, addon_group_id, name, price, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, group, name, price, active, 0);
  }
  for (const group of ['ag-size', 'ag-extras', 'ag-retired']) {
    db.prepare(`INSERT INTO addon_group_product (product_id, addon_group_id) VALUES (?, ?)`).run('prod-pizza', group);
  }

  const app = express();
  app.use(express.json());
  app.use((req: any, res: any, next: any) => {
    if (!req.path.startsWith('/api')) { next(); return; }
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { res.status(401).json({ error: 'Authentication required' }); return; }
    try {
      req.user = jwt.verify(authHeader.split(' ')[1], getJWTSecret());
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  });
  app.use('/api/orders', orderRoutes);

  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const authHeader = `Bearer ${jwt.sign({ userId: ownerId, email: 'owner-probe@test.local', role: 'owner' }, getJWTSecret(), { expiresIn: '1h' })}`;

  const order = (items: any[]) => request(baseUrl, '/api/orders', {
    method: 'POST',
    headers: { Authorization: authHeader },
    body: JSON.stringify({ type: 'takeaway', items }),
  });

  try {
    console.log('\nP1. REQUIRED group ("Tamaño de Pizza", min 1) with NO addons array at all');
    {
      const res = await order([{ product_id: 'prod-pizza', quantity: 1 }]);
      report('expected 400 if required groups are backend-enforced', res.status, res.data);
      assertEqual(res.status, 400, 'order omitting a required group is rejected');
    }

    console.log('\nP2. REQUIRED group with an explicitly empty addons array');
    {
      const res = await order([{ product_id: 'prod-pizza', quantity: 1, addons: [] }]);
      report('expected 400', res.status, res.data);
      assertEqual(res.status, 400, 'order with empty addons for a required group is rejected');
    }

    console.log('\nP3. Optional group selected, REQUIRED group still missing');
    {
      const res = await order([{
        product_id: 'prod-pizza', quantity: 1,
        addons: [{ id: 'addon-queso', name: 'Queso', price: 4000, quantity: 1 }],
      }]);
      report('expected 400', res.status, res.data);
      assertEqual(res.status, 400, 'partial selection missing the required group is rejected');
    }

    console.log('\nP4. max_selection exceeded (6 extras where max is 5)');
    {
      const res = await order([{
        product_id: 'prod-pizza', quantity: 1,
        addons: [
          { id: 'addon-personal', name: 'Personal', price: 0, quantity: 1 },
          { id: 'addon-queso', name: 'Q', price: 4000, quantity: 3 },
          { id: 'addon-tocineta', name: 'T', price: 4500, quantity: 3 },
        ],
      }]);
      report('expected 400', res.status, res.data);
      assertEqual(res.status, 400, 'exceeding max_selection is rejected');
    }

    console.log('\nP5. allow_multiple_quantities = 0 with quantity 2 (size group)');
    {
      const res = await order([{
        product_id: 'prod-pizza', quantity: 1,
        addons: [{ id: 'addon-mediana', name: 'Mediana', price: 6000, quantity: 2 }],
      }]);
      report('expected 400', res.status, res.data);
      assertEqual(res.status, 400, 'multi-quantity on a single-choice group is rejected');
    }

    console.log('\nP6. Single-choice group, TWO different addons sent (Mediana + Familiar)');
    {
      const res = await order([{
        product_id: 'prod-pizza', quantity: 1,
        addons: [
          { id: 'addon-mediana', name: 'Mediana', price: 6000, quantity: 1 },
          { id: 'addon-familiar', name: 'Familiar', price: 12000, quantity: 1 },
        ],
      }]);
      report('expected 400 (max_selection 1)', res.status, res.data);
      assertEqual(res.status, 400, 'two choices in a 1-of-N group are rejected');
    }

    console.log('\nP7. Same addon id sent TWICE as separate entries');
    {
      const res = await order([{
        product_id: 'prod-pizza', quantity: 1,
        addons: [
          { id: 'addon-personal', name: 'Personal', price: 0, quantity: 1 },
          { id: 'addon-queso', name: 'Queso', price: 4000, quantity: 1 },
          { id: 'addon-queso', name: 'Queso', price: 4000, quantity: 1 },
        ],
      }]);
      report('group allows multiple quantities, so the two entries merge', res.status, res.data);
      assertEqual(res.status, 201, 'duplicate entries are accepted on a multi-quantity group');
      if (res.status === 201) {
        const itemId = (db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(res.data.order.id) as any).id;
        const rows = db.prepare("SELECT * FROM order_item_addons WHERE order_item_id = ? AND addon_id = 'addon-queso'").all(itemId) as any[];
        assertEqual(rows.length, 1, 'the repeated add-on is stored as a single merged row');
        assertEqual(rows[0]?.quantity, 2, 'merged row carries the summed quantity');
      }
    }

    console.log('\nP8. Addon belonging to a DEACTIVATED group still linked to the product');
    {
      const res = await order([{
        product_id: 'prod-pizza', quantity: 1,
        addons: [
          { id: 'addon-personal', name: 'Personal', price: 0, quantity: 1 },
          { id: 'addon-retirado', name: 'Retirado', price: 7000, quantity: 1 },
        ],
      }]);
      report('expected 400 — group is_active = 0', res.status, res.data);
      assertEqual(res.status, 400, 'addon from a deactivated group is rejected');
    }

    console.log('\nP9. Deactivated addon inside an active group');
    {
      const res = await order([{
        product_id: 'prod-pizza', quantity: 1,
        addons: [
          { id: 'addon-personal', name: 'Personal', price: 0, quantity: 1 },
          { id: 'addon-inactivo', name: 'Descontinuada', price: 9000, quantity: 1 },
        ],
      }]);
      report('expected 400', res.status, res.data);
      assertEqual(res.status, 400, 'inactive addon is rejected');
    }

    console.log('\nP10. Addon offered on pizza sent with a DIFFERENT product (coffee)');
    {
      const res = await order([{
        product_id: 'prod-coffee', quantity: 1,
        addons: [{ id: 'addon-queso', name: 'Queso', price: 4000, quantity: 1 }],
      }]);
      report('expected 400', res.status, res.data);
      assertEqual(res.status, 400, 'addon not linked to the product is rejected');
    }

    console.log('\nP11. Client sends a TAMPERED addon price (0 instead of 6000)');
    {
      const res = await order([{
        product_id: 'prod-pizza', quantity: 1,
        addons: [{ id: 'addon-mediana', name: 'GRATIS', price: 0, quantity: 1 }],
      }]);
      report('expected 201 with catalog price enforced', res.status, res.data);
      assertEqual(res.status, 201, 'order accepted');
      if (res.status === 201) {
        const itemId = (db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(res.data.order.id) as any).id;
        const row = db.prepare('SELECT * FROM order_item_addons WHERE order_item_id = ?').get(itemId) as any;
        assertEqual(row?.price, 6000, 'catalog price overrides the client-sent price');
        assertEqual(row?.addon_name, 'Mediana', 'catalog name overrides the client-sent name');
        const item = db.prepare('SELECT * FROM order_items WHERE id = ?').get(itemId) as any;
        assertEqual(item?.subtotal, 44000, 'item subtotal uses the catalog addon price (38000 + 6000)');
      }
    }

    console.log('\nP12. Addon price multiplies by LINE quantity (2 pizzas x 1 extra)');
    {
      const res = await order([{
        product_id: 'prod-pizza', quantity: 2,
        addons: [
          { id: 'addon-personal', name: 'Personal', price: 0, quantity: 1 },
          { id: 'addon-queso', name: 'Queso', price: 4000, quantity: 1 },
        ],
      }]);
      report('expected 201, subtotal 2*(38000+4000)', res.status, res.data);
      if (res.status === 201) {
        const item = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(res.data.order.id) as any;
        assertEqual(item?.subtotal, 84000, 'subtotal = 2 x (38000 + 4000)');
        const rows = db.prepare('SELECT * FROM order_item_addons WHERE order_item_id = ?').all(item.id) as any[];
        const queso = rows.find((r) => r.addon_id === 'addon-queso');
        assertEqual(queso?.quantity, 1, 'stored addon quantity stays PER UNIT (not multiplied by line qty)');
      }
    }

    console.log('\nP13. Fractional / negative addon quantities');
    {
      const frac = await order([{
        product_id: 'prod-pizza', quantity: 1,
        addons: [{ id: 'addon-queso', name: 'Q', price: 4000, quantity: 1.5 }],
      }]);
      report('fractional', frac.status, frac.data);
      assertEqual(frac.status, 400, 'fractional addon quantity is rejected');

      const neg = await order([{
        product_id: 'prod-pizza', quantity: 1,
        addons: [{ id: 'addon-queso', name: 'Q', price: 4000, quantity: -2 }],
      }]);
      report('negative', neg.status, neg.data);
      assertEqual(neg.status, 400, 'negative addon quantity is rejected');
    }

    console.log('\nP14. Historical snapshot survives catalog edits');
    {
      const res = await order([{
        product_id: 'prod-pizza', quantity: 1,
        addons: [
          { id: 'addon-personal', name: 'Personal', price: 0, quantity: 1 },
          { id: 'addon-champinon', name: 'Champiñones', price: 3500, quantity: 1 },
        ],
      }]);
      assertEqual(res.status, 201, 'order created before the catalog edit');
      if (res.status === 201) {
        const itemId = (db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(res.data.order.id) as any).id;
        db.prepare('UPDATE addons SET price = ?, name = ?, is_active = 0 WHERE id = ?')
          .run(99999, 'Champiñones (RENOMBRADO)', 'addon-champinon');
        const row = db.prepare("SELECT * FROM order_item_addons WHERE order_item_id = ? AND addon_id = 'addon-champinon'").get(itemId) as any;
        assertEqual(row?.price, 3500, 'historical order keeps the price charged at sale time');
        assertEqual(row?.addon_name, 'Champiñones Frescos', 'historical order keeps the name sold at sale time');
      }
    }

    console.log('\nP15. Checkbox group (allow_multiple_quantities = 0, max 2): same sauce sent TWICE at qty 1');
    {
      db.prepare(`INSERT INTO addon_groups (id, name, is_required, min_selection, max_selection, allow_multiple_quantities, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?)`).run('ag-salsa', 'Salsa de Acompanamiento', 0, 0, 2, 0, 1);
      db.prepare(`INSERT INTO addons (id, addon_group_id, name, price, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('addon-bbq', 'ag-salsa', 'Salsa BBQ', 2000, 1, 0);
      db.prepare(`INSERT INTO addon_group_product (product_id, addon_group_id) VALUES (?, ?)`).run('prod-pizza', 'ag-salsa');

      const direct = await order([{
        product_id: 'prod-pizza', quantity: 1,
        addons: [
          { id: 'addon-personal', name: 'Personal', price: 0, quantity: 1 },
          { id: 'addon-bbq', name: 'BBQ', price: 2000, quantity: 2 },
        ],
      }]);
      report('qty:2 in one entry - guard should fire', direct.status, direct.data);
      assertEqual(direct.status, 400, 'single entry with quantity 2 is rejected by the multi-quantity guard');

      const split = await order([{
        product_id: 'prod-pizza', quantity: 1,
        addons: [
          { id: 'addon-personal', name: 'Personal', price: 0, quantity: 1 },
          { id: 'addon-bbq', name: 'BBQ', price: 2000, quantity: 1 },
          { id: 'addon-bbq', name: 'BBQ', price: 2000, quantity: 1 },
        ],
      }]);
      report('SAME addon split across two entries', split.status, split.data);
      assertEqual(split.status, 400, 'splitting into two entries is rejected the same way');
      if (split.status === 201) {
        const item = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(split.data.order.id) as any;
        console.log('    -> charged subtotal ' + item.subtotal + ' (42000 means the guard was bypassed)');
      }
    }

    console.log('\nP16. Append path POST /orders/:id/items - required group omitted');
    {
      const base = await order([{
        product_id: 'prod-pizza', quantity: 1,
        addons: [{ id: 'addon-personal', name: 'Personal', price: 0, quantity: 1 }],
      }]);
      const appended = await request(baseUrl, '/api/orders/' + base.data.order.id + '/items', {
        method: 'POST',
        headers: { Authorization: authHeader },
        body: JSON.stringify({ items: [{ product_id: 'prod-pizza', quantity: 1 }] }),
      });
      report('expected 400', appended.status, appended.data);
      assertEqual(appended.status, 400, 'append path also enforces the required group');
    }

    console.log('\n' + '='.repeat(60));
    console.log(`${passed}/${passed + failed} passed, ${failed} failed`);
  } finally {
    server.close();
    closeDatabase();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
