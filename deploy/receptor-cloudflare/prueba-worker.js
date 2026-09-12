/**
 * El receptor completo, ejercitado como lo haría un POS real, sin desplegar
 * nada y sin cuenta de Cloudflare.
 *
 * D1 se sustituye por SQLite de verdad (`node:sqlite`), que es el mismo motor
 * que D1 usa por dentro. Así el esquema y cada consulta se validan en serio: si
 * una columna no existe o el SQL está mal, esto falla aquí y no en producción.
 *
 *   node deploy/receptor-cloudflare/prueba-worker.js
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import worker from './src/worker.js';

const AQUI = dirname(fileURLToPath(import.meta.url));

let bien = 0;
const fallos = [];
const check = (cond, msg) => {
  if (cond) { bien++; console.log('  ok   ' + msg); }
  else { fallos.push(msg); console.log('  MAL  ' + msg); }
};

// ── D1 simulado sobre SQLite real ───────────────────────────────────────────
function crearD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(AQUI, 'schema.sql'), 'utf8'));
  return {
    _db: db,
    prepare(sql) {
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async first() { return db.prepare(sql).get(...args) ?? null; },
        // D1 informa cuántas filas cambió; el worker lo usa para distinguir un
        // evento nuevo de un reintento, así que el simulado debe hacerlo igual.
        async run() {
          const r = db.prepare(sql).run(...args);
          return { success: true, meta: { changes: Number(r.changes ?? 0) } };
        },
        async all() { return { results: db.prepare(sql).all(...args) }; },
      };
      return api;
    },
  };
}

// ── KV simulado ─────────────────────────────────────────────────────────────
function crearKv() {
  const m = new Map();
  return { async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); } };
}

// ── Un POS que firma igual que el de verdad ─────────────────────────────────
const sha256Hex = (v) => createHash('sha256').update(v).digest('hex');
const hmacHex = (s, v) => createHmac('sha256', s).update(v).digest('hex');

function peticionFirmada(apiKey, posHash, metodo, ruta, cuerpoObj) {
  const cuerpo = JSON.stringify(cuerpoObj);
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  const base = [metodo, ruta, timestamp, nonce, sha256Hex(cuerpo)].join('\n');
  return new Request('https://receptor.ejemplo' + ruta, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
      'X-Flo-POS-Hash': posHash,
      'X-Flo-Timestamp': timestamp,
      'X-Flo-Nonce': nonce,
      'X-Flo-Body-SHA256': sha256Hex(cuerpo),
      'X-Flo-Signature': 'sha256=' + hmacHex(apiKey, base),
    },
    body: cuerpo,
  });
}

// ── Los avisos se capturan en vez de enviarse ───────────────────────────────
const avisos = [];
globalThis.fetch = async (url, init) => {
  if (String(url).includes('api.telegram.org')) {
    avisos.push(JSON.parse(init.body).text);
    return new Response('{"ok":true}', { status: 200 });
  }
  throw new Error('llamada inesperada a ' + url);
};

const env = {
  DB: crearD1(),
  NONCES: crearKv(),
  TELEGRAM_TOKEN: 'prueba',
  TELEGRAM_CHAT_ID: '1',
};

const POS_HASH = 'pos_asocampo_0001';

console.log('\nReceptor de soporte — recorrido completo');
console.log('='.repeat(58));

// ── 1. Alta ─────────────────────────────────────────────────────────────────
console.log('\n1. La tienda se da de alta');
let apiKey, storeId;
{
  const r = await worker.fetch(new Request('https://receptor.ejemplo/api/pos/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Flo-POS-Hash': POS_HASH },
    body: JSON.stringify({
      pos_hash: POS_HASH, app_version: '3.7.2', platform: 'win32', device_name: 'CAJA-01',
      business: { name: 'Asocampo', phone: '', country: 'CO', timezone: 'America/Bogota', currency: 'COP' },
    }),
  }), env);
  const d = await r.json();
  check(r.status === 200 && !!d.api_key, 'responde con una clave');
  check(typeof d.store_id === 'string' && d.store_id.startsWith('st_'), 'y con un identificador de tienda');
  apiKey = d.api_key; storeId = d.store_id;
  check(avisos.some((a) => a.includes('Asocampo')), 'le avisa que hay una tienda nueva');
}

// El POS puede reintentar el alta: no debe quedar con dos identidades.
{
  const r = await worker.fetch(new Request('https://receptor.ejemplo/api/pos/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Flo-POS-Hash': POS_HASH },
    body: JSON.stringify({ pos_hash: POS_HASH, business: { name: 'Asocampo' } }),
  }), env);
  const d = await r.json();
  check(d.api_key === apiKey && d.store_id === storeId, 'reintentar el alta devuelve la misma clave');
}

// ── 2. Un error ─────────────────────────────────────────────────────────────
console.log('\n2. Llega un error');
const eventoId = randomUUID();
{
  const evento = {
    event_id: eventoId, event_code: 'api.server_error', severity: 'error',
    message: 'HTTP 500', occurred_at: new Date().toISOString(),
    metadata: { http_status: 500, method: 'POST', route: '/api/customers', os_platform: 'win32' },
  };
  const r = await worker.fetch(peticionFirmada(apiKey, POS_HASH, 'POST', '/api/pos/diagnostics', evento), env);
  check(r.status === 200, 'se acepta (' + r.status + ')');

  const fila = await env.DB.prepare('SELECT * FROM eventos WHERE event_id = ?').bind(eventoId).first();
  check(!!fila, 'y queda guardado ANTES de responder');
  check(fila?.store_id === storeId, 'atribuido a la tienda correcta');
  check(fila?.huella === 'api.server_error|/api/customers', 'con huella para agrupar: ' + fila?.huella);
  check(avisos.some((a) => a.includes('api.server_error')), 'y le llega el aviso');
}

// ── 3. Reintento y repetición ───────────────────────────────────────────────
console.log('\n3. El POS reintenta y el fallo se repite');
{
  const antesAvisos = avisos.length;
  // Mismo event_id: el POS no vio la respuesta y reintenta.
  const evento = {
    event_id: eventoId, event_code: 'api.server_error', severity: 'error',
    message: 'HTTP 500', metadata: { route: '/api/customers' },
  };
  const r = await worker.fetch(peticionFirmada(apiKey, POS_HASH, 'POST', '/api/pos/diagnostics', evento), env);
  check(r.status === 200, 'el reintento también responde 200, no un error');

  const cuantos = await env.DB.prepare('SELECT COUNT(*) AS c FROM eventos WHERE event_id = ?').bind(eventoId).first();
  check(cuantos.c === 1, 'y no se duplica la fila');

  // Otro evento, mismo problema: no debe volver a molestar.
  const otro = {
    event_id: randomUUID(), event_code: 'api.server_error', severity: 'error',
    message: 'HTTP 500', metadata: { route: '/api/customers' },
  };
  await worker.fetch(peticionFirmada(apiKey, POS_HASH, 'POST', '/api/pos/diagnostics', otro), env);
  check(avisos.length === antesAvisos, 'el mismo problema repetido no genera otro aviso');
}

// ── 4. El latido ────────────────────────────────────────────────────────────
console.log('\n4. Cómo va el cliente');
{
  const r = await worker.fetch(peticionFirmada(apiKey, POS_HASH, 'POST', '/api/pos/heartbeat', {
    pos_hash: POS_HASH, app_version: '3.7.2', device_name: 'CAJA-01',
    active_orders: 3, today_sales: 480000, today_bills: 27, sent_at: new Date().toISOString(),
  }), env);
  check(r.status === 200, 'el latido se acepta');

  const l = await env.DB.prepare('SELECT * FROM latidos WHERE store_id = ?').bind(storeId).first();
  check(l?.ventas_hoy === 480000 && l?.facturas_hoy === 27,
    'y queda el dato del día: $' + l?.ventas_hoy + ' en ' + l?.facturas_hoy + ' facturas');
}

// ── 5. Un tique ─────────────────────────────────────────────────────────────
console.log('\n5. El comerciante escribe');
{
  const antes = avisos.length;
  const r = await worker.fetch(peticionFirmada(apiKey, POS_HASH, 'POST', '/api/pos/support-ticket', {
    client_ticket_id: randomUUID(), subject: 'No me imprime',
    message: 'Desde ayer no salen los recibos', severity: 'high', app_version: '3.7.2',
  }), env);
  check(r.status === 200, 'el tique se acepta');
  check(avisos.length > antes && avisos.some((a) => a.includes('No me imprime')),
    'y avisa siempre, porque hay alguien esperando');
}

// ── 6. Lo que hay que rechazar ──────────────────────────────────────────────
console.log('\n6. Lo que no debe entrar');
{
  const conClaveFalsa = peticionFirmada('qt_live_falsa', POS_HASH, 'POST', '/api/pos/diagnostics', { event_id: randomUUID() });
  let r = await worker.fetch(conClaveFalsa, env);
  check(r.status === 401, 'una clave desconocida: ' + r.status);

  const p = peticionFirmada(apiKey, POS_HASH, 'POST', '/api/pos/diagnostics', { event_id: randomUUID(), event_code: 'x' });
  const copia = p.clone();
  await worker.fetch(p, env);
  r = await worker.fetch(copia, env);
  check(r.status === 401, 'la misma petición reenviada (nonce repetido): ' + r.status);

  r = await worker.fetch(new Request('https://receptor.ejemplo/api/pos/diagnostics', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + apiKey }, body: '{}',
  }), env);
  check(r.status === 401, 'una petición sin firmar: ' + r.status);

  r = await worker.fetch(new Request('https://receptor.ejemplo/otra/cosa'), env);
  check(r.status === 404, 'una ruta que no existe: ' + r.status);
}

// ── 7. El resumen diario ────────────────────────────────────────────────────
console.log('\n7. El resumen diario');
{
  const antes = avisos.length;
  const pendientes = [];
  await worker.scheduled({}, env, { waitUntil: (p) => pendientes.push(p) });
  await Promise.all(pendientes);
  check(avisos.length > antes, 'se genera');
  const resumen = avisos[avisos.length - 1];
  check(resumen.includes('api.server_error'), 'y trae el error más repetido');
}

console.log('\n' + '='.repeat(58));
console.log(`resultado: ${bien} bien, ${fallos.length} mal`);
if (fallos.length) { fallos.forEach((f) => console.log('  - ' + f)); process.exit(1); }
