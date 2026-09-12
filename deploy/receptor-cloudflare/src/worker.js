/**
 * Receptor de soporte de QualityTech — Cloudflare Worker.
 *
 * Recibe lo que los POS de sus clientes le mandan: errores, tiques y latidos.
 * Cuatro endpoints, ninguna lógica complicada. La parte delicada —verificar la
 * firma— vive en firma.js y tiene su propia prueba.
 *
 * Regla que gobierna todo el archivo: **sólo se responde 2xx después de haber
 * guardado.** El POS borra el evento de su cola en cuanto ve un 2xx; responder
 * antes de tiempo lo pierde para siempre.
 */
import { verificarFirma } from './firma.js';

const ahora = () => new Date().toISOString();

const json = (datos, status = 200) =>
  new Response(JSON.stringify(datos), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** Un identificador que no se puede adivinar. */
function clave(prefijo) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return prefijo + hex;
}

/**
 * Agrupa lo repetido.
 *
 * Sin esto, una tienda en bucle de caídas manda cientos de eventos idénticos y
 * el panel se vuelve inútil. La huella junta el código con el lugar del fallo,
 * que es lo que de verdad distingue un problema de otro.
 */
function huellaDe(evento) {
  const m = evento.metadata || {};
  const lugar = m.route || (typeof m.stack === 'string' ? m.stack.split('|')[1] || '' : '') || '';
  return (evento.event_code + '|' + lugar).slice(0, 200).trim();
}

/** Busca la tienda por su clave, que es lo que trae la cabecera Authorization. */
async function tiendaPorClave(env, request) {
  const cabecera = request.headers.get('Authorization') || '';
  const apiKey = cabecera.replace(/^Bearer\s+/i, '').trim();
  if (!apiKey) return null;
  const fila = await env.DB.prepare(
    'SELECT store_id, api_key, nombre, activa FROM tiendas WHERE api_key = ?',
  ).bind(apiKey).first();
  if (!fila || !fila.activa) return null;
  return fila;
}

/** El nonce sólo vale una vez; KV lo olvida solo pasada la ventana. */
async function nonceYaVisto(env, nonce) {
  if (!env.NONCES) return false;
  const visto = await env.NONCES.get('n:' + nonce);
  if (visto) return true;
  await env.NONCES.put('n:' + nonce, '1', { expirationTtl: 600 });
  return false;
}

/**
 * Todo lo firmado pasa por aquí: identifica la tienda, valida el sello y
 * entrega el cuerpo ya leído.
 */
async function autenticar(request, env, url) {
  const tienda = await tiendaPorClave(env, request);
  if (!tienda) return { error: json({ error: 'unknown store' }, 401) };

  const cuerpo = await request.text();
  const verificacion = await verificarFirma({
    metodo: request.method,
    rutaConConsulta: url.pathname + url.search,
    cabeceras: request.headers,
    cuerpo,
    apiKey: tienda.api_key,
    nonceYaVisto: (n) => nonceYaVisto(env, n),
  });
  if (!verificacion.ok) return { error: json({ error: verificacion.motivo }, 401) };

  let datos = {};
  try { datos = cuerpo ? JSON.parse(cuerpo) : {}; } catch { datos = {}; }
  return { tienda, datos };
}

/** Marca que esa tienda dio señales de vida. */
const marcarVista = (env, storeId) =>
  env.DB.prepare('UPDATE tiendas SET vista_en = ? WHERE store_id = ?').bind(ahora(), storeId).run();

/**
 * El aviso a su teléfono. Telegram porque es gratis e inmediato; si prefiere
 * WhatsApp, aquí se cambia la URL por la de la API oficial de Business.
 *
 * Nunca revienta hacia afuera: que falle el aviso no puede hacer que se pierda
 * el evento que ya se guardó.
 */
async function avisar(env, texto) {
  if (!env.TELEGRAM_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: texto,
        disable_web_page_preview: true,
      }),
    });
  } catch {
    // Se pierde el aviso, no el evento.
  }
}

// ── Alta de una tienda ───────────────────────────────────────────────────────
// El único endpoint sin firmar: todavía no hay clave con que firmar. A cambio,
// es el único que crea credenciales, así que conviene vigilarlo.
async function registrar(request, env) {
  const posHash = request.headers.get('X-Flo-POS-Hash') || '';
  if (!posHash) return json({ error: 'missing pos hash' }, 400);

  const datos = await request.json().catch(() => ({}));
  const negocio = datos.business || {};

  // Si esa instalación ya se dio de alta, se le devuelve su misma clave: el POS
  // puede reintentar el alta y no debe terminar con dos identidades.
  const existente = await env.DB.prepare(
    'SELECT store_id, api_key FROM tiendas WHERE pos_hash = ?',
  ).bind(posHash).first();

  if (existente) {
    return json({ api_key: existente.api_key, store_id: existente.store_id, pos_id: posHash });
  }

  const storeId = clave('st_');
  const apiKey = clave('qt_live_');

  await env.DB.prepare(`
    INSERT INTO tiendas
      (store_id, pos_hash, api_key, nombre, contacto, telefono, pais,
       zona_horaria, moneda, app_version, plataforma, device_name, activa, creada_en, vista_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).bind(
    storeId, posHash, apiKey,
    negocio.name || null, negocio.contact_name || null, negocio.phone || null,
    negocio.country || null, negocio.timezone || null, negocio.currency || null,
    datos.app_version || null, datos.platform || null, datos.device_name || null,
    ahora(), ahora(),
  ).run();

  await avisar(env, `🟢 Tienda nueva: ${negocio.name || '(sin nombre)'}\n${storeId} · ${datos.app_version || '?'}`);
  return json({ api_key: apiKey, store_id: storeId, pos_id: posHash });
}

// ── Los errores ──────────────────────────────────────────────────────────────
async function diagnostico(request, env, url) {
  const a = await autenticar(request, env, url);
  if (a.error) return a.error;
  const { tienda, datos } = a;

  if (!datos.event_id) return json({ error: 'missing event_id' }, 400);
  const huella = huellaDe(datos);

  // INSERT OR IGNORE: el POS reintenta hasta ver un 2xx, así que el mismo
  // evento puede llegar más de una vez. Repetirlo no debe duplicar la fila ni
  // hacer fallar la respuesta.
  const insercion = await env.DB.prepare(`
    INSERT OR IGNORE INTO eventos
      (event_id, store_id, event_code, severidad, mensaje, correlation_id, metadata, huella, ocurrio_en, recibido_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    datos.event_id, tienda.store_id, datos.event_code || 'desconocido',
    datos.severity || 'error', datos.message || '', datos.correlation_id || null,
    JSON.stringify(datos.metadata || {}), huella,
    datos.occurred_at || null, ahora(),
  ).run();

  await marcarVista(env, tienda.store_id);

  // Un reintento del MISMO evento no es un problema nuevo: el POS reintenta con
  // espera creciente hasta ver un 2xx, y avisar en cada intento llenaría el
  // teléfono con el mismo fallo. Sólo cuenta lo que de verdad entró.
  const esNuevo = (insercion?.meta?.changes ?? 0) > 0;

  // Sólo molesta con lo grave, y sólo la primera vez de cada problema en la
  // última hora: si no, un bucle de caídas se convierte en cien avisos.
  if (esNuevo && (datos.severity === 'error' || datos.severity === 'critical')) {
    const haceUnaHora = new Date(Date.now() - 3600_000).toISOString();
    const repetidos = await env.DB.prepare(
      'SELECT COUNT(*) AS c FROM eventos WHERE store_id = ? AND huella = ? AND recibido_en >= ?',
    ).bind(tienda.store_id, huella, haceUnaHora).first();

    if ((repetidos?.c ?? 0) <= 1) {
      await avisar(env,
        `🔴 ${tienda.nombre || tienda.store_id}\n` +
        `${datos.event_code}\n${datos.message || ''}`.slice(0, 900));
    }
  }

  return json({ ok: true });
}

// ── Los tiques que escribe el comerciante ────────────────────────────────────
async function tique(request, env, url) {
  const a = await autenticar(request, env, url);
  if (a.error) return a.error;
  const { tienda, datos } = a;

  if (!datos.client_ticket_id) return json({ error: 'missing client_ticket_id' }, 400);

  await env.DB.prepare(`
    INSERT OR IGNORE INTO tiques
      (client_ticket_id, store_id, asunto, mensaje, severidad, event_code,
       correlation_id, contacto, app_version, plataforma, diagnostico, estado, recibido_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'abierto', ?)
  `).bind(
    datos.client_ticket_id, tienda.store_id, datos.subject || '', datos.message || '',
    datos.severity || 'normal', datos.event_code || null, datos.correlation_id || null,
    JSON.stringify(datos.contact || {}), datos.app_version || null, datos.platform || null,
    JSON.stringify(datos.diagnostics || null), ahora(),
  ).run();

  await marcarVista(env, tienda.store_id);
  // Un tique siempre avisa: lo escribió una persona que está esperando.
  await avisar(env,
    `📩 ${tienda.nombre || tienda.store_id}\n${datos.subject || '(sin asunto)'}\n` +
    `${datos.message || ''}`.slice(0, 900));

  return json({ ok: true, ticket_id: datos.client_ticket_id });
}

// ── El latido: cómo va cada cliente ──────────────────────────────────────────
async function latido(request, env, url) {
  const a = await autenticar(request, env, url);
  if (a.error) return a.error;
  const { tienda, datos } = a;

  await env.DB.prepare(`
    INSERT INTO latidos
      (store_id, app_version, device_name, pedidos_activos, ventas_hoy, facturas_hoy, enviado_en, recibido_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    tienda.store_id, datos.app_version || null, datos.device_name || null,
    datos.active_orders ?? null, datos.today_sales ?? null, datos.today_bills ?? null,
    datos.sent_at || null, ahora(),
  ).run();

  await env.DB.prepare('UPDATE tiendas SET vista_en = ?, app_version = ? WHERE store_id = ?')
    .bind(ahora(), datos.app_version || null, tienda.store_id).run();

  return json({ ok: true });
}

// ── Consentimiento y prueba de conexión ──────────────────────────────────────
async function consentimiento(request, env, url) {
  const a = await autenticar(request, env, url);
  if (a.error) return a.error;
  await env.DB.prepare(`
    INSERT INTO consentimientos (store_id, acepta, actualizado) VALUES (?, ?, ?)
    ON CONFLICT(store_id) DO UPDATE SET acepta = excluded.acepta, actualizado = excluded.actualizado
  `).bind(a.tienda.store_id, a.datos.enabled ? 1 : 0, ahora()).run();
  return json({ ok: true });
}

async function pruebaConexion(request, env, url) {
  const a = await autenticar(request, env, url);
  if (a.error) return a.error;
  await marcarVista(env, a.tienda.store_id);
  return json({ ok: true, store_id: a.tienda.store_id, server_time: ahora() });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ruta = url.pathname;

    if (ruta === '/api/pos/register' && request.method === 'POST') return registrar(request, env);
    if (ruta === '/api/pos/diagnostics' && request.method === 'POST') return diagnostico(request, env, url);
    if (ruta === '/api/pos/support-ticket' && request.method === 'POST') return tique(request, env, url);
    if (ruta === '/api/pos/heartbeat' && request.method === 'POST') return latido(request, env, url);
    if (ruta === '/api/pos/diagnostics-consent' && request.method === 'POST') return consentimiento(request, env, url);
    if (ruta === '/api/pos/connection-test' && request.method === 'POST') return pruebaConexion(request, env, url);

    // El POS pregunta por comandos pendientes; todavía no se envía ninguno.
    if (ruta === '/api/pos/commands') return json({ commands: [] });

    return json({ error: 'not found' }, 404);
  },

  /**
   * Resumen diario. Se configura en wrangler.toml; sin cron, no corre.
   */
  async scheduled(evento, env, ctx) {
    ctx.waitUntil((async () => {
      const desde = new Date(Date.now() - 24 * 3600_000).toISOString();

      const errores = await env.DB.prepare(`
        SELECT t.nombre, e.event_code, COUNT(*) AS veces
        FROM eventos e JOIN tiendas t ON t.store_id = e.store_id
        WHERE e.recibido_en >= ? AND e.severidad IN ('error','critical')
        GROUP BY t.nombre, e.event_code ORDER BY veces DESC LIMIT 10
      `).bind(desde).all();

      const calladas = await env.DB.prepare(`
        SELECT nombre FROM tiendas
        WHERE activa = 1 AND (vista_en IS NULL OR vista_en < ?)
      `).bind(desde).all();

      const lineas = ['📊 Resumen de 24 horas', ''];
      const filas = errores.results || [];
      lineas.push(filas.length ? 'Errores más repetidos:' : 'Sin errores. Buen día.');
      for (const f of filas) lineas.push(`  ${f.veces}×  ${f.nombre || '?'} — ${f.event_code}`);

      const sinSeñal = calladas.results || [];
      if (sinSeñal.length) {
        lineas.push('', 'Sin dar señales en 24 h:');
        for (const t of sinSeñal) lineas.push('  · ' + (t.nombre || '?'));
      }

      await avisar(env, lineas.join('\n').slice(0, 3500));
    })());
  },
};
