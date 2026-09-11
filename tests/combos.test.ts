/**
 * Combos, kits and baskets — one product, several out of stock
 *
 * The two cases the merchant described are the same fact: a fruver's "canasta
 * verde" (apio + lechuga + 1 kg de espinaca) and a restaurant's "combo fiesta"
 * (guaro + pizza + gaseosa). What is checked:
 *
 *   · Selling one combo takes every component out, in its own units, and never
 *     touches the combo itself — a combo keeps no stock of its own.
 *   · What can be sold is what the scarcest component allows, and a sale that
 *     would exceed it is refused before anything is written.
 *   · Cancelling gives back exactly what was taken, read from the record of
 *     that sale — not from today's recipe, which may have changed since.
 *   · A component that does not track stock limits nothing and blocks nothing.
 *   · Fractional components work: a basket with 1 kg of spinach.
 *   · A combo may not contain a combo, nor itself, nor a component twice.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/combos.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-combos-'));
Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-combos';

const express = require('express');
const jwt = require('jsonwebtoken');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { productRoutes } = require('../main/routes/products');
const { orderRoutes } = require('../main/routes/orders');
const { registerRoutes } = require('../main/routes/index');
const { findStockLedgerMismatches } = require('../main/services/inventory');
const { availableUnits, comboCost } = require('../main/services/combos');

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
  if (Math.abs(actual - expected) < 0.0001) { passed++; console.log(`  ✓ ${message}`); }
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

async function main() {
  console.log('Combos, kits and baskets');
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
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('timezone', 'America/Bogota', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(stamp);
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('currency', 'COP', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(stamp);

  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
              VALUES ('owner-cb', 'owner', 'owner-cb@test.local', 'x', 'owner', 1, ?, ?)`).run(stamp, stamp);
  db.prepare(`INSERT INTO categories (id, name, created_at, updated_at) VALUES ('cat-cb', 'Canastas', ?, ?)`).run(stamp, stamp);

  const seed = (id: string, name: string, price: number, opts: {
    stock?: number; tracks?: boolean; unit?: string; cost?: number;
  } = {}) => {
    const unit = opts.unit || 'each';
    db.prepare(`INSERT INTO products (id, category_id, name, price, cost, track_inventory, stock_quantity, sale_unit, allow_fractional_quantity, created_at, updated_at)
                VALUES (?, 'cat-cb', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, name, price, opts.cost ?? 0, opts.tracks === false ? 0 : 1, opts.stock ?? 0,
        unit, unit === 'each' ? 0 : 1, stamp, stamp);
  };

  const stockOf = (id: string) =>
    Number((db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(id) as any).stock_quantity);

  const app = express();
  app.use(express.json());
  app.use((req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) { res.status(401).json({ error: 'Authentication required' }); return; }
    try { req.user = jwt.verify(header.split(' ')[1], getJWTSecret()); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  });
  registerRoutes(app);

  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const owner = jwt.sign({ userId: 'owner-cb', email: 'owner-cb@test.local', role: 'owner' }, getJWTSecret(), { expiresIn: '1h' });

  try {
    // ── 1. The fruver basket ──────────────────────────────────────────────
    console.log('\n1. Canasta verde (fruver)');
    seed('apio', 'Apio', 2000, { stock: 30, cost: 900 });
    seed('lechuga', 'Lechuga', 3000, { stock: 20, cost: 1400 });
    seed('espinaca', 'Espinaca', 8000, { stock: 12.5, unit: 'kg', cost: 5000 });
    seed('canasta', 'Canasta Verde', 12000, { stock: 0 });

    const armar = await call(baseUrl, 'PUT', '/api/products/canasta/components', owner, {
      components: [
        { product_id: 'apio', quantity: 1 },
        { product_id: 'lechuga', quantity: 1 },
        { product_id: 'espinaca', quantity: 1 },
      ],
    });
    assertEqual(armar.status, 200, 'the basket is defined with its three components');
    assertEqual(armar.data.components.length, 3, 'and holds all three');
    // 30 celery, 20 lettuce, 12.5 kg spinach → the spinach allows 12.
    assertEqual(armar.data.available_units, 12, 'it can be sold twelve times — what the scarcest part allows');
    assertClose(armar.data.combo_cost, 900 + 1400 + 5000, 'and costs what its parts cost');

    const asProduct = await call(baseUrl, 'GET', '/api/products/canasta', owner);
    assertEqual(asProduct.data.product.track_inventory, false,
      'the basket keeps no stock of its own — a second number would always be wrong');

    // ── 2. Selling one takes every part out ───────────────────────────────
    console.log('\n2. Selling a basket');
    const venta = await call(baseUrl, 'POST', '/api/orders', owner, {
      type: 'takeaway', items: [{ product_id: 'canasta', quantity: 2 }],
    });
    assertEqual(venta.status, 201, 'two baskets are sold as one line');
    assertClose(stockOf('apio'), 28, 'two celery left the stock');
    assertClose(stockOf('lechuga'), 18, 'two lettuce too');
    assertClose(stockOf('espinaca'), 10.5, 'and two kilos of spinach');
    assertClose(stockOf('canasta'), 0, 'the basket itself moved nothing');

    const lineaId = venta.data.order.items[0].id;
    const salieron = db.prepare('SELECT * FROM order_item_components WHERE order_item_id = ?').all(lineaId) as any[];
    assertEqual(salieron.length, 3, 'what came out is recorded for that sale');
    assertClose(salieron.find((r) => r.product_id === 'espinaca').quantity, 2, 'with the real amounts');

    const movimientos = db.prepare(
      `SELECT * FROM stock_movements WHERE product_id = 'apio' ORDER BY id`,
    ).all() as any[];
    assertEqual(movimientos.length, 1, 'the component has its own ledger movement');
    assertEqual(movimientos[0].note, 'combo', 'marked as coming from a combo');

    // ── 3. What the scarcest part allows ──────────────────────────────────
    console.log('\n3. Running out');
    assertEqual(availableUnits(db, 'canasta'), 10, 'after selling two, ten baskets remain possible');
    const demasiadas = await call(baseUrl, 'POST', '/api/orders', owner, {
      type: 'takeaway', items: [{ product_id: 'canasta', quantity: 11 }],
    });
    assertEqual(demasiadas.status, 400, 'eleven is refused: the spinach does not reach');
    assertClose(stockOf('apio'), 28, 'and the refusal wrote nothing — celery untouched');
    assertClose(stockOf('espinaca'), 10.5, 'spinach untouched too');

    // ── 4. Cancelling gives back what was taken ───────────────────────────
    console.log('\n4. Cancelling the sale');
    const cancelada = await call(baseUrl, 'PATCH', `/api/orders/${venta.data.order.id}/status`, owner, {
      status: 'cancelled', reason: 'El cliente se arrepintió',
    });
    assertEqual(cancelada.status, 200, 'the order is cancelled');
    assertClose(stockOf('apio'), 30, 'celery is back');
    assertClose(stockOf('lechuga'), 20, 'lettuce is back');
    assertClose(stockOf('espinaca'), 12.5, 'and the two kilos of spinach are back');

    // ── 5. A changed recipe does not rewrite history ──────────────────────
    console.log('\n5. Changing the recipe afterwards');
    seed('cilantro', 'Cilantro', 1000, { stock: 50, cost: 400 });
    const venta2 = await call(baseUrl, 'POST', '/api/orders', owner, {
      type: 'takeaway', items: [{ product_id: 'canasta', quantity: 1 }],
    });
    assertClose(stockOf('apio'), 29, 'one celery left with this sale');

    await call(baseUrl, 'PUT', '/api/products/canasta/components', owner, {
      components: [
        { product_id: 'apio', quantity: 3 },
        { product_id: 'cilantro', quantity: 2 },
      ],
    });
    const cancelada2 = await call(baseUrl, 'PATCH', `/api/orders/${venta2.data.order.id}/status`, owner, {
      status: 'cancelled', reason: 'Prueba',
    });
    assertEqual(cancelada2.status, 200, 'the old sale is cancelled after the recipe changed');
    assertClose(stockOf('apio'), 30, 'it gives back the one celery it took, not the three the recipe now says');
    assertClose(stockOf('cilantro'), 50, 'and no cilantro appears out of nowhere');

    // ── 6. The restaurant combo, with an untracked component ──────────────
    console.log('\n6. Combo fiesta (restaurante)');
    seed('guaro', 'Botella de guaro', 60000, { stock: 4, cost: 38000 });
    seed('pizza', 'Pizza familiar', 45000, { stock: 6, cost: 20000 });
    seed('gaseosa', 'Gaseosa', 5000, { tracks: false, cost: 2000 });
    seed('combo', 'Combo Fiesta', 99000, { stock: 0 });

    const armarCombo = await call(baseUrl, 'PUT', '/api/products/combo/components', owner, {
      components: [
        { product_id: 'guaro', quantity: 1 },
        { product_id: 'pizza', quantity: 1 },
        { product_id: 'gaseosa', quantity: 2 },
      ],
    });
    assertEqual(armarCombo.status, 200, 'the combo is defined');
    assertEqual(armarCombo.data.available_units, 4, 'four possible — the guaro is the limit, the soda counts for nothing');

    const ventaCombo = await call(baseUrl, 'POST', '/api/orders', owner, {
      type: 'dine_in', items: [{ product_id: 'combo', quantity: 1 }],
    });
    assertEqual(ventaCombo.status, 201, 'a combo is sold');
    assertClose(stockOf('guaro'), 3, 'one bottle left');
    assertClose(stockOf('pizza'), 5, 'one pizza left');
    assertClose(stockOf('gaseosa'), 0, 'the untracked soda moved no stock');

    const comboLine = ventaCombo.data.order.items[0].id;
    const registro = db.prepare('SELECT * FROM order_item_components WHERE order_item_id = ?').all(comboLine) as any[];
    assertEqual(registro.length, 3, 'but it is still on the record of what was handed over');
    assertClose(registro.find((r) => r.product_id === 'gaseosa').quantity, 2, 'with the two sodas');

    // ── 7. What a combo may not be ────────────────────────────────────────
    console.log('\n7. What is refused');
    const siMismo = await call(baseUrl, 'PUT', '/api/products/combo/components', owner, {
      components: [{ product_id: 'combo', quantity: 1 }],
    });
    assertEqual(siMismo.status, 400, 'a combo cannot contain itself');

    const anidado = await call(baseUrl, 'PUT', '/api/products/canasta/components', owner, {
      components: [{ product_id: 'combo', quantity: 1 }],
    });
    assertEqual(anidado.status, 400, 'nor another combo');

    const repetido = await call(baseUrl, 'PUT', '/api/products/combo/components', owner, {
      components: [{ product_id: 'guaro', quantity: 1 }, { product_id: 'guaro', quantity: 2 }],
    });
    assertEqual(repetido.status, 400, 'a component cannot appear twice — that is a larger quantity');

    const cantidadCero = await call(baseUrl, 'PUT', '/api/products/combo/components', owner, {
      components: [{ product_id: 'guaro', quantity: 0 }],
    });
    assertEqual(cantidadCero.status, 400, 'a component of zero is refused');

    const noExiste = await call(baseUrl, 'PUT', '/api/products/combo/components', owner, {
      components: [{ product_id: 'no-existe', quantity: 1 }],
    });
    assertEqual(noExiste.status, 404, 'so is a component that does not exist');

    // A product that is already part of a combo cannot become a combo itself:
    // that is how nesting would sneak in through the back door.
    const parteDeOtro = await call(baseUrl, 'PUT', '/api/products/guaro/components', owner, {
      components: [{ product_id: 'pizza', quantity: 1 }],
    });
    assertEqual(parteDeOtro.status, 409, 'a product already used inside a combo cannot become one');

    // ── 8. Turning a combo back into an ordinary product ──────────────────
    console.log('\n8. Undoing a combo');
    const vaciar = await call(baseUrl, 'PUT', '/api/products/canasta/components', owner, { components: [] });
    assertEqual(vaciar.status, 200, 'clearing the component list is allowed');
    assertEqual(vaciar.data.components.length, 0, 'and leaves an ordinary product');
    assertEqual(vaciar.data.available_units, null, 'with no combo availability to report');

    const ventaSuelta = await call(baseUrl, 'POST', '/api/orders', owner, {
      type: 'takeaway', items: [{ product_id: 'canasta', quantity: 1 }],
    });
    assertEqual(ventaSuelta.status, 201, 'it can still be sold, now as itself');
    assertClose(stockOf('apio'), 30, 'and no component moves any more');

    // ── 9. The ledger still reconciles ────────────────────────────────────
    console.log('\n9. Reconciliation');
    assertEqual(findStockLedgerMismatches(db).length, 0, 'every product agrees with its last movement');
    assertClose(comboCost(db, 'combo'), 38000 + 20000 + 2 * 2000, 'the combo cost adds up its parts');

    const huerfanos = db.prepare(`
      SELECT COUNT(*) AS n FROM order_item_components oic
      LEFT JOIN order_items oi ON oi.id = oic.order_item_id WHERE oi.id IS NULL
    `).get() as { n: number };
    assertEqual(Number(huerfanos.n), 0, 'and no record of components is left orphaned');

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
