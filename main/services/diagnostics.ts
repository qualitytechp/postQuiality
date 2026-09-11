/**
 * Lo que se le cuenta a soporte cuando algo falla, y lo que nunca sale de la
 * máquina del comerciante.
 *
 * La pantalla de Privacidad le promete al comerciante que el diagnóstico «nunca
 * incluye nombres de clientes, teléfonos, direcciones ni contenido de pedidos».
 * Un código de error de impresora cumplía eso solo. Un mensaje de excepción o
 * una traza de pila no: pueden traer el valor que rompió una restricción, la
 * ruta del perfil de Windows, o un texto que el usuario tecleó.
 *
 * Por eso todo lo que sale pasa por `redactDiagnosticText`. Es deliberadamente
 * severo: ante la duda tacha. Un diagnóstico con un dato de menos sigue
 * sirviendo para dar soporte; uno con un teléfono de más rompe la promesa.
 */

/** El tope del canal de diagnóstico, igual que el que ya usaba la impresora. */
export const MAX_DIAGNOSTIC_MESSAGE = 300;
/** Una traza más larga que esto no aporta: el fallo está en los primeros marcos. */
export const MAX_DIAGNOSTIC_STACK = 2000;

const REGLAS: Array<{ patron: RegExp; reemplazo: string }> = [
  // Correos.
  { patron: /[\w.+-]+@[\w-]+\.[\w.-]+/g, reemplazo: '<correo>' },

  // El perfil del usuario en la ruta: "C:\Users\Maria\..." lleva su nombre.
  { patron: /([A-Za-z]:\\Users\\)[^\\/:*?"<>|\r\n]+/g, reemplazo: '$1<usuario>' },
  { patron: /(\/(?:home|Users)\/)[^/\s]+/g, reemplazo: '$1<usuario>' },

  // Tarjetas y documentos: cualquier tirada larga de dígitos.
  { patron: /\b\d[\d\s-]{11,}\d\b/g, reemplazo: '<numero>' },

  // Teléfonos: de 7 a 15 dígitos, con o sin separadores y prefijo.
  { patron: /\+?\d[\d\s().-]{5,}\d/g, reemplazo: '<telefono>' },

  // Lo que venga entre comillas en un mensaje de SQLite suele ser el valor que
  // rompió la restricción, no el nombre de la columna.
  { patron: /'[^']{3,}'/g, reemplazo: "'<valor>'" },
];

/**
 * Deja un texto en condiciones de salir de la máquina.
 *
 * El orden de las reglas importa: los correos primero, porque si no la regla de
 * teléfonos podría morder los dígitos de una dirección.
 */
export function redactDiagnosticText(texto: unknown, limite = MAX_DIAGNOSTIC_MESSAGE): string {
  if (texto === null || texto === undefined) return '';
  let salida = String(texto);
  for (const { patron, reemplazo } of REGLAS) {
    salida = salida.replace(patron, reemplazo);
  }
  salida = salida.replace(/\s+/g, ' ').trim();
  return salida.length > limite ? salida.slice(0, limite - 1) + '…' : salida;
}

/**
 * La traza, recortada a los marcos de arriba y sin rutas que identifiquen a
 * nadie. Se conserva la forma (archivo:línea) porque es lo que ubica el fallo.
 */
export function redactDiagnosticStack(stack: unknown, maxFrames = 12): string {
  if (!stack) return '';
  const lineas = String(stack).split('\n').slice(0, maxFrames + 1);
  return redactDiagnosticText(lineas.join(' | '), MAX_DIAGNOSTIC_STACK);
}

/**
 * La ruta de una petición, sin lo que pueda venir escrito por una persona.
 *
 * Se queda con el patrón —`/api/customers/:id`— y descarta la cadena de
 * consulta entera: ahí es donde viaja lo que alguien tecleó en un buscador.
 */
export function redactRoutePath(ruta: unknown): string {
  if (!ruta) return '';
  const sinConsulta = String(ruta).split('?')[0];
  const partes = sinConsulta.split('/').map((parte) => {
    if (!parte) return parte;
    // Identificadores: uuid, numérico, o cualquier cosa larga sin pinta de palabra.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parte)) return ':id';
    if (/^\d+$/.test(parte)) return ':id';
    if (parte.length > 24) return ':id';
    return parte;
  });
  return redactDiagnosticText(partes.join('/'), 200);
}

// La escala la define el canal en cloud-sync.ts; aquí sólo se reusa.
export type DiagnosticSeverity = 'debug' | 'info' | 'warn' | 'error' | 'critical';

export interface BuiltDiagnostic {
  event_code: string;
  severity: DiagnosticSeverity;
  message: string;
  metadata: Record<string, unknown>;
}

/**
 * Arma un diagnóstico a partir de un error, ya saneado.
 *
 * `extra` es para datos que el llamador sabe que son seguros (un código HTTP,
 * un nombre de plataforma). Sus valores de texto también se tachan, porque
 * «seguro» es fácil de creer y difícil de sostener.
 */
export function buildDiagnostic(
  eventCode: string,
  error: unknown,
  extra: Record<string, unknown> = {},
  severity: DiagnosticSeverity = 'error',
): BuiltDiagnostic {
  const esError = error instanceof Error;
  const mensaje = esError ? error.message : String(error ?? '');
  const metadata: Record<string, unknown> = {
    error_name: esError ? error.name : typeof error,
    os_platform: process.platform,
  };
  const traza = redactDiagnosticStack(esError ? error.stack : undefined);
  if (traza) metadata.stack = traza;

  for (const [clave, valor] of Object.entries(extra)) {
    if (valor === undefined || valor === null) continue;
    metadata[clave] = typeof valor === 'string' ? redactDiagnosticText(valor, 200) : valor;
  }

  return {
    event_code: eventCode,
    severity,
    message: redactDiagnosticText(mensaje) || '(sin mensaje)',
    metadata,
  };
}

/**
 * Envía un error al canal de diagnóstico de la tienda.
 *
 * Nunca lanza: un fallo al reportar no puede tapar el fallo real, que es la
 * lección que ya dejó escrita el reporte de la impresora.
 *
 * El `require` es diferido a propósito. Así este módulo —el que contiene las
 * reglas de tachado— se puede probar solo, sin arrastrar la base de datos, los
 * websockets ni el registro de Electron.
 */
export function reportDiagnosticError(
  eventCode: string,
  error: unknown,
  extra: Record<string, unknown> = {},
  severity: DiagnosticSeverity = 'error',
): void {
  try {
    const { randomUUID } = require('crypto') as typeof import('crypto');
    const { cloudSync } = require('./cloud-sync') as typeof import('./cloud-sync');
    const armado = buildDiagnostic(eventCode, error, extra, severity);
    cloudSync.reportDiagnostic({
      event_id: randomUUID(),
      event_code: armado.event_code,
      severity: armado.severity,
      message: armado.message,
      metadata: armado.metadata,
      occurred_at: new Date().toISOString(),
    });
  } catch {
    // Si el diagnóstico no se puede encolar, se pierde y ya. No se escala.
  }
}
