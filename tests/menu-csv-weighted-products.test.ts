/** Coverage for weighted-sale columns in catalog CSV import/export.
 *  sale_unit, allow_fractional_quantity and weight_precision are optional:
 *  files without them must keep the stored values untouched. */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-menu-csv-weighted-'));

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
  api,
  assert,
  assertEqual,
  assertIncludes,
  getResults,
  closeDatabase,
  getDatabase,
} = require('./helpers/test-setup');
const { menuCsvRoutes } = require('../main/routes/menu-csv');

const LEGACY_HEADER = 'id,sku,name,category,price,description,cost,tax_category,tax_behavior,cashback_percent,tags,is_active';
const WEIGHTED_HEADER = `${LEGACY_HEADER},sale_unit,allow_fractional_quantity,weight_precision`;

const csvWith = (header: string, ...rows: string[]) => [header, ...rows].join('\n');

function productRow(name: string): { id: string; sale_unit: string; allow_fractional_quantity: number; weight_precision: number } {
  return getDatabase()
    .prepare('SELECT id, sale_unit, allow_fractional_quantity, weight_precision FROM products WHERE name = ?')
    .get(name);
}

async function importProducts(baseUrl: string, authHeader: Record<string, string>, csv: string) {
  return api(baseUrl, '/api/menu/csv/import/products', { method: 'POST', body: { csv }, headers: authHeader });
}

async function main() {
  console.log('Integration Test: weighted-sale columns in catalog CSV');
  console.log('='.repeat(58));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-weighed', 'Produce');

  const app = createApp({ '/api/menu/csv': menuCsvRoutes });
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n─── Importing weighted products ───');
    {
      const res = await importProducts(baseUrl, authHeader, csvWith(WEIGHTED_HEADER,
        ',,Tomatoes,Produce,80,,40,,,,,yes,kg,yes,3',
        ',,Olive Oil Tin,Produce,500,,300,,,,,yes,each,no,',
      ));
      assertEqual(res.status, 200, 'weighted product CSV is accepted');
      assertEqual(res.data.created, 2, 'both rows are created');

      const tomatoes = productRow('Tomatoes');
      assertEqual(tomatoes.sale_unit, 'kg', 'sale_unit is stored from the CSV');
      assertEqual(tomatoes.allow_fractional_quantity, 1, 'allow_fractional_quantity is stored from the CSV');
      assertEqual(tomatoes.weight_precision, 3, 'weight_precision is stored from the CSV');

      const tin = productRow('Olive Oil Tin');
      assertEqual(tin.sale_unit, 'each', 'each-unit row stays unweighted');
      assertEqual(tin.allow_fractional_quantity, 0, 'each-unit row keeps fractional quantities off');
    }

    console.log('\n─── Files without the columns keep current behaviour ───');
    {
      const res = await importProducts(baseUrl, authHeader, csvWith(LEGACY_HEADER,
        ',,Plain Cookie,Produce,20,,10,,,,,yes',
      ));
      assertEqual(res.status, 200, 'a legacy CSV without the new columns still imports');
      const cookie = productRow('Plain Cookie');
      assertEqual(cookie.sale_unit, 'each', 'omitted sale_unit defaults to each');
      assertEqual(cookie.allow_fractional_quantity, 0, 'omitted allow_fractional_quantity defaults to off');
    }

    console.log('\n─── Rejected combinations ───');
    {
      const badUnit = await importProducts(baseUrl, authHeader, csvWith(WEIGHTED_HEADER,
        ',,Bad Unit,Produce,10,,,,,,,yes,litre,no,',
      ));
      assertEqual(badUnit.data.failed, 1, 'an unsupported sale_unit is rejected');
      assertIncludes(badUnit.data.errors[0], 'sale_unit', 'the error names sale_unit');

      const badFractional = await importProducts(baseUrl, authHeader, csvWith(WEIGHTED_HEADER,
        ',,Bad Fractional,Produce,10,,,,,,,yes,each,yes,',
      ));
      assertEqual(badFractional.data.failed, 1, 'fractional quantities on an each-unit row are rejected');

      const badPrecision = await importProducts(baseUrl, authHeader, csvWith(WEIGHTED_HEADER,
        ',,Bad Precision,Produce,10,,,,,,,yes,kg,yes,9',
      ));
      assertEqual(badPrecision.data.failed, 1, 'an out-of-range weight_precision is rejected');
    }

    console.log('\n─── Updating by id ───');
    {
      const tomatoId = productRow('Tomatoes').id;

      const legacyUpdate = await importProducts(baseUrl, authHeader, csvWith(LEGACY_HEADER,
        `${tomatoId},,Tomatoes,Produce,90,,40,,,,,yes`,
      ));
      assertEqual(legacyUpdate.data.updated, 1, 'a legacy CSV can still update a weighted product');
      const afterLegacy = productRow('Tomatoes');
      assertEqual(afterLegacy.sale_unit, 'kg', 'an absent sale_unit column preserves the stored unit');
      assertEqual(afterLegacy.allow_fractional_quantity, 1, 'an absent column preserves stored fractional quantities');

      const contradictory = await importProducts(baseUrl, authHeader, csvWith(
        `${LEGACY_HEADER},sale_unit`,
        `${tomatoId},,Tomatoes,Produce,90,,40,,,,,yes,each`,
      ));
      assertEqual(contradictory.data.failed, 1, 'switching a fractional product to each is rejected');
      assertEqual(productRow('Tomatoes').sale_unit, 'kg', 'the rejected row leaves the product untouched');

      const consistent = await importProducts(baseUrl, authHeader, csvWith(
        `${LEGACY_HEADER},sale_unit,allow_fractional_quantity`,
        `${tomatoId},,Tomatoes,Produce,90,,40,,,,,yes,each,no`,
      ));
      assertEqual(consistent.data.updated, 1, 'switching to each together with fractional off is accepted');
      const switched = productRow('Tomatoes');
      assertEqual(switched.sale_unit, 'each', 'the unit is switched');
      assertEqual(switched.allow_fractional_quantity, 0, 'fractional quantities are turned off with it');
    }

    console.log('\n─── Export round-trip ───');
    {
      const response = await (globalThis as any).fetch(`${baseUrl}/api/menu/csv/export/products`, { headers: authHeader });
      const csv = await response.text();
      assertIncludes(csv, 'sale_unit,allow_fractional_quantity,weight_precision', 'the export header carries the new columns');
      assert(/Olive Oil Tin[^\n]*,each,no,/.test(csv), 'an each-unit product exports its unit');
    }
  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }

  const { passed, failed, total } = getResults();
  console.log('\n' + '='.repeat(58));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
