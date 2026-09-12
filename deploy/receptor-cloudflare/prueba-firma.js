/**
 * ¿Acepta el receptor exactamente lo que el POS firma?
 *
 * Esta prueba firma con el MISMO algoritmo que `buildSignedHeaders()` de
 * main/services/cloud-sync.ts, escrito aquí con el `crypto` de Node —es decir,
 * por un camino distinto al del receptor, que usa Web Crypto—. Si las dos
 * implementaciones coinciden, la firma cuadra de verdad y no por casualidad.
 *
 * Corre sin desplegar nada:
 *   node deploy/receptor-cloudflare/prueba-firma.js
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { verificarFirma } from './src/firma.js';

let bien = 0;
const fallos = [];
const check = (cond, msg) => {
  if (cond) { bien++; console.log('  ok   ' + msg); }
  else { fallos.push(msg); console.log('  MAL  ' + msg); }
};

// ── Copia fiel de lo que hace el POS ────────────────────────────────────────
const sha256Hex = (v) => createHash('sha256').update(v).digest('hex');
const hmacHex = (secreto, v) => createHmac('sha256', secreto).update(v).digest('hex');

function firmarComoElPos(apiKey, posHash, metodo, rutaFirmada, cuerpo) {
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  const hashCuerpo = sha256Hex(cuerpo);
  const base = [metodo.toUpperCase(), rutaFirmada, timestamp, nonce, hashCuerpo].join('\n');
  return {
    'Authorization': `Bearer ${apiKey}`,
    'X-Flo-POS-Hash': posHash,
    'X-Flo-Timestamp': timestamp,
    'X-Flo-Nonce': nonce,
    'X-Flo-Body-SHA256': hashCuerpo,
    'X-Flo-Signature': `sha256=${hmacHex(apiKey, base)}`,
  };
}

const CLAVE = 'qt_live_' + 'x'.repeat(40);
const POS_HASH = 'pos_prueba_0001';

console.log('\nFirma del POS contra el receptor de Cloudflare');
console.log('='.repeat(58));

// ── 1. El caso normal ───────────────────────────────────────────────────────
console.log('\n1. Una petición legítima');
{
  const cuerpo = JSON.stringify({
    event_id: randomUUID(), event_code: 'api.server_error', severity: 'error',
    message: 'HTTP 500', metadata: { route: '/api/customers', http_status: 500 },
    occurred_at: new Date().toISOString(),
  });
  const ruta = '/api/pos/diagnostics';
  const cabeceras = firmarComoElPos(CLAVE, POS_HASH, 'POST', ruta, cuerpo);
  const r = await verificarFirma({
    metodo: 'POST', rutaConConsulta: ruta, cabeceras, cuerpo, apiKey: CLAVE,
  });
  check(r.ok, 'un diagnóstico firmado por el POS se acepta' + (r.ok ? '' : ' — ' + r.motivo));
}

// ── 2. Lo que tiene que rechazar ────────────────────────────────────────────
console.log('\n2. Lo que tiene que rechazar');
{
  const cuerpo = '{"a":1}';
  const ruta = '/api/pos/heartbeat';

  const conClaveAjena = firmarComoElPos('otra_clave_distinta', POS_HASH, 'POST', ruta, cuerpo);
  let r = await verificarFirma({ metodo: 'POST', rutaConConsulta: ruta, cabeceras: conClaveAjena, cuerpo, apiKey: CLAVE });
  check(!r.ok && r.motivo === 'firma incorrecta', 'una clave que no es la de esa tienda');

  const ok = firmarComoElPos(CLAVE, POS_HASH, 'POST', ruta, cuerpo);
  r = await verificarFirma({ metodo: 'POST', rutaConConsulta: ruta, cabeceras: ok, cuerpo: '{"a":2}', apiKey: CLAVE });
  check(!r.ok, 'un cuerpo cambiado después de firmar');

  r = await verificarFirma({ metodo: 'POST', rutaConConsulta: '/api/pos/diagnostics', cabeceras: ok, cuerpo, apiKey: CLAVE });
  check(!r.ok && r.motivo === 'firma incorrecta', 'la misma firma reapuntada a otra ruta');

  r = await verificarFirma({ metodo: 'GET', rutaConConsulta: ruta, cabeceras: ok, cuerpo, apiKey: CLAVE });
  check(!r.ok && r.motivo === 'firma incorrecta', 'el mismo sello con otro método');

  // Seis minutos después: la ventana es de cinco.
  r = await verificarFirma({
    metodo: 'POST', rutaConConsulta: ruta, cabeceras: ok, cuerpo, apiKey: CLAVE,
    ahora: Date.now() + 6 * 60 * 1000,
  });
  check(!r.ok && r.motivo === 'timestamp fuera de ventana', 'una petición capturada y reenviada tarde');

  // Reenvío inmediato: firma válida, pero el nonce ya se usó.
  const vistos = new Set([ok['X-Flo-Nonce']]);
  r = await verificarFirma({
    metodo: 'POST', rutaConConsulta: ruta, cabeceras: ok, cuerpo, apiKey: CLAVE,
    nonceYaVisto: async (n) => vistos.has(n),
  });
  check(!r.ok && r.motivo === 'nonce repetido', 'el mismo sello usado dos veces');

  const sinCabeceras = { 'Authorization': 'Bearer ' + CLAVE };
  r = await verificarFirma({ metodo: 'POST', rutaConConsulta: ruta, cabeceras: sinCabeceras, cuerpo, apiKey: CLAVE });
  check(!r.ok && r.motivo === 'faltan cabeceras de firma', 'una petición sin firmar');
}

// ── 3. Detalles que rompen en producción ────────────────────────────────────
console.log('\n3. Detalles que rompen en producción');
{
  // Un GET va con cuerpo vacío, y su hash es el del string vacío.
  const ruta = '/api/pos/commands?limit=5';
  const cabeceras = firmarComoElPos(CLAVE, POS_HASH, 'GET', ruta, '');
  const r = await verificarFirma({ metodo: 'GET', rutaConConsulta: ruta, cabeceras, cuerpo: '', apiKey: CLAVE });
  check(r.ok, 'un GET con cuerpo vacío y consulta en la ruta' + (r.ok ? '' : ' — ' + r.motivo));

  // La consulta forma parte de lo firmado: quitarla invalida.
  const r2 = await verificarFirma({ metodo: 'GET', rutaConConsulta: '/api/pos/commands', cabeceras, cuerpo: '', apiKey: CLAVE });
  check(!r2.ok, 'y si se pierde la consulta por el camino, no cuadra');

  // Acentos y emoji: el POS firma sobre UTF-8.
  const cuerpoUtf8 = JSON.stringify({ message: 'No se pudo imprimir — café ☕' });
  const c3 = firmarComoElPos(CLAVE, POS_HASH, 'POST', '/api/pos/diagnostics', cuerpoUtf8);
  const r3 = await verificarFirma({
    metodo: 'POST', rutaConConsulta: '/api/pos/diagnostics', cabeceras: c3, cuerpo: cuerpoUtf8, apiKey: CLAVE,
  });
  check(r3.ok, 'un cuerpo con acentos y emoji' + (r3.ok ? '' : ' — ' + r3.motivo));
}

console.log('\n' + '='.repeat(58));
console.log(`resultado: ${bien} bien, ${fallos.length} mal`);
if (fallos.length) { fallos.forEach((f) => console.log('  - ' + f)); process.exit(1); }
