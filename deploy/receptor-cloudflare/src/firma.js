/**
 * Verificación de la firma con que el POS sella cada petición.
 *
 * Está aparte del worker a propósito: es la única pieza donde un error se paga
 * caro y en silencio —una verificación floja acepta peticiones falsas, una
 * estricta de más rechaza a un cliente real sin dejar rastro claro—, así que se
 * puede probar sola, en Node, sin desplegar nada.
 *
 * Usa Web Crypto, que existe igual en Cloudflare Workers y en Node 18+. Sin
 * dependencias, sin compilación.
 */

const VENTANA_MS = 5 * 60 * 1000;

const aHex = (buffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(texto) {
  const datos = new TextEncoder().encode(texto);
  return aHex(await crypto.subtle.digest('SHA-256', datos));
}

export async function hmacHex(secreto, texto) {
  const clave = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secreto),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return aHex(await crypto.subtle.sign('HMAC', clave, new TextEncoder().encode(texto)));
}

/**
 * Comparación en tiempo constante.
 *
 * Un `===` sobre la firma se corta en el primer byte distinto, y ese tiempo
 * distinto es medible: permite adivinar la firma byte por byte.
 */
function igualesEnTiempoConstante(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diferencia = 0;
  for (let i = 0; i < a.length; i++) diferencia |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferencia === 0;
}

/**
 * La base que el POS firma. Debe reconstruirse byte por byte igual:
 * cualquier diferencia —un salto de línea, la consulta, el método en
 * minúsculas— da una firma distinta y la petición se rechaza.
 */
export async function construirBase(metodo, rutaConConsulta, timestamp, nonce, cuerpo) {
  return [
    metodo.toUpperCase(),
    rutaConConsulta,
    timestamp,
    nonce,
    await sha256Hex(cuerpo),
  ].join('\n');
}

/**
 * @param {object} p
 * @param {string} p.metodo            GET, POST…
 * @param {string} p.rutaConConsulta   "/api/pos/diagnostics" (con "?..." si lo hubiera)
 * @param {Headers|Map} p.cabeceras    las de la petición
 * @param {string} p.cuerpo            el cuerpo crudo, tal como llegó
 * @param {string} p.apiKey            la clave de esa tienda
 * @param {number} [p.ahora]           para poder probar el vencimiento
 * @param {(nonce:string)=>Promise<boolean>} [p.nonceYaVisto]
 * @returns {Promise<{ok:boolean, motivo?:string}>}
 */
export async function verificarFirma(p) {
  const leer = (nombre) =>
    (typeof p.cabeceras.get === 'function' ? p.cabeceras.get(nombre) : p.cabeceras[nombre]) || '';

  const timestamp = leer('X-Flo-Timestamp');
  const nonce = leer('X-Flo-Nonce');
  const hashCuerpo = leer('X-Flo-Body-SHA256');
  const firma = leer('X-Flo-Signature');

  if (!timestamp || !nonce || !firma) return { ok: false, motivo: 'faltan cabeceras de firma' };
  if (!p.apiKey) return { ok: false, motivo: 'tienda sin clave' };

  // Vencimiento: una petición capturada no sirve para siempre.
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return { ok: false, motivo: 'timestamp ilegible' };
  const ahora = p.ahora ?? Date.now();
  if (Math.abs(ahora - t) > VENTANA_MS) return { ok: false, motivo: 'timestamp fuera de ventana' };

  // El cuerpo tiene que ser el que se firmó.
  const hashReal = await sha256Hex(p.cuerpo ?? '');
  if (hashCuerpo && !igualesEnTiempoConstante(hashCuerpo, hashReal)) {
    return { ok: false, motivo: 'el cuerpo no coincide con su hash' };
  }

  const base = await construirBase(p.metodo, p.rutaConConsulta, timestamp, nonce, p.cuerpo ?? '');
  const esperada = await hmacHex(p.apiKey, base);
  const recibida = String(firma).replace(/^sha256=/, '');
  if (!igualesEnTiempoConstante(esperada, recibida)) return { ok: false, motivo: 'firma incorrecta' };

  // Reenvío: la firma es válida, pero ya se usó.
  if (p.nonceYaVisto && (await p.nonceYaVisto(nonce))) {
    return { ok: false, motivo: 'nonce repetido' };
  }

  return { ok: true };
}
