/**
 * Customers can be found by their ID document as well as their phone.
 *
 * This drives the real endpoints rather than re-running the SQL, because the
 * POS field strips everything but digits before searching — a document that is
 * only reachable through a hand-written query would still be unreachable to a
 * cashier.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-customer-document-'));

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
  api,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
  getDatabase,
} = require('./helpers/test-setup');
const { customerRoutes } = require('../main/routes/customers');

async function main() {
  console.log('Integration Test: customer search by ID document');
  console.log('='.repeat(58));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);

  const app = createApp({ '/api/customers': customerRoutes });
  require('../main/routes/index').registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  const create = (body: Record<string, unknown>) =>
    api(baseUrl, '/api/customers', { method: 'POST', body, headers: authHeader });
  const inlineSearch = (q: string) =>
    api(baseUrl, `/api/customers-search?q=${encodeURIComponent(q)}`, { headers: authHeader });

  try {
    console.log('\n─── Storing a document ───');
    {
      const res = await create({ name: 'Carolina Ciro', document: '21482387', phone: '+573155294216' });
      assertEqual(res.status, 201, 'a customer with a document is created');
      assertEqual(res.data.customer.document, '21482387', 'the document is stored');
    }
    {
      // El caso que motivó todo: 161 de 457 socios no tienen teléfono.
      const res = await create({ name: 'Doris Henao', document: '21668237' });
      assertEqual(res.status, 201, 'a customer with no phone at all is still created');
      assertEqual(res.data.customer.phone, null, 'and is stored without a phone');
    }

    console.log('\n─── Finding by document ───');
    {
      const res = await inlineSearch('21668237');
      assertEqual(res.status, 200, 'the POS lookup responds');
      assertEqual(res.data.length, 1, 'the phoneless customer is found by document');
      assertEqual(res.data[0].name, 'Doris Henao', 'and it is the right person');
    }
    {
      const res = await inlineSearch('2148');
      assert(res.data.some((c: any) => c.name === 'Carolina Ciro'), 'a partial document still matches');
    }
    {
      const res = await inlineSearch('3155294216');
      assertEqual(res.data.length, 1, 'searching by phone still works');
      assertEqual(res.data[0].name, 'Carolina Ciro', 'and returns the phone owner');
    }

    console.log('\n─── Punctuation in the stored document ───');
    {
      // La lista del cliente trae las cédulas con separadores de miles.
      await create({ name: 'Lea Tapias', document: '22.243.472' });
      const res = await inlineSearch('22243472');
      assert(res.data.some((c: any) => c.name === 'Lea Tapias'),
        'a document typed without dots finds one stored with them');
    }

    console.log('\n─── Editing ───');
    {
      const created = await create({ name: 'Editable Person', document: '111' });
      const id = created.data.customer.id;

      const updated = await api(baseUrl, `/api/customers/${id}`, {
        method: 'PUT', body: { document: '222' }, headers: authHeader,
      });
      assertEqual(updated.data.customer.document, '222', 'the document can be changed');

      const nameOnly = await api(baseUrl, `/api/customers/${id}`, {
        method: 'PUT', body: { name: 'Renamed Person' }, headers: authHeader,
      });
      assertEqual(nameOnly.data.customer.document, '222',
        'an update that omits the document leaves it alone');

      const cleared = await api(baseUrl, `/api/customers/${id}`, {
        method: 'PUT', body: { document: '' }, headers: authHeader,
      });
      assertEqual(cleared.data.customer.document, null, 'and it can be cleared');
    }

    console.log('\n─── Businesses that never use it ───');
    {
      const res = await create({ name: 'Restaurant Guest', phone: '+573001112233' });
      assertEqual(res.status, 201, 'a customer created without a document is unaffected');
      assertEqual(res.data.customer.document, null, 'the column stays empty');

      const row = getDatabase()
        .prepare('SELECT document_digits FROM customers WHERE name = ?')
        .get('Restaurant Guest') as { document_digits: string | null };
      assertEqual(row.document_digits, null, 'and never matches a document search');

      const search = await inlineSearch('0001112233');
      assertEqual(search.data.length, 0, 'an unrelated digit string finds nobody');
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
