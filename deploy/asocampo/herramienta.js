/**
 * Herramienta del instalador de Asocampo.
 *
 * Usa `node:sqlite`, que viene dentro de Node: la máquina no necesita tener
 * sqlite3.exe ni instalar ninguna dependencia.
 *
 * Órdenes:
 *   node herramienta.js respaldar <carpeta-datos> <carpeta-respaldos>
 *   node herramienta.js promover  <flo.db-origen> <carpeta-datos>
 *   node herramienta.js puntocero <carpeta-datos> <punto-cero.sql>
 *   node herramienta.js verificar <carpeta-datos>
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const [, , orden, ...args] = process.argv;

function salir(mensaje, codigo = 1) {
  console.error('ERROR: ' + mensaje);
  process.exit(codigo);
}

function rutaDb(carpeta) {
  const db = path.join(carpeta, 'flo.db');
  if (!fs.existsSync(db)) salir('no existe la base en ' + db);
  return db;
}

function marcaDeTiempo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Copia la base con VACUUM INTO en vez de copiar el archivo.
 *
 * SQLite trabaja en modo WAL: los cambios recientes viven en flo.db-wal, no en
 * flo.db. Copiar sólo el archivo principal da una foto vieja o inservible.
 * VACUUM INTO escribe un archivo único, ya consolidado y compacto.
 */
function copiaLimpia(origen, destino) {
  const db = new DatabaseSync(origen, { open: true, readOnly: true });
  try {
    db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

/**
 * Las tablas que el script va a tocar, sacadas del propio script.
 * Así no hay dos listas que puedan quedar desalineadas.
 */
function tablasQueUsa(guion) {
  const nombres = new Set();
  for (const m of guion.matchAll(/^\s*(?:DELETE\s+FROM|UPDATE)\s+([A-Za-z_][A-Za-z0-9_]*)/gim)) {
    nombres.add(m[1]);
  }
  return [...nombres];
}

/**
 * Una base vieja no tiene todas esas tablas y el borrado se caeria a la mitad.
 * Se comprueba antes de abrir la transaccion, y se explica que hacer.
 */
function comprobarEsquema(db, guion) {
  const existentes = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
  );
  const faltan = tablasQueUsa(guion).filter((t) => !existentes.has(t));
  if (faltan.length === 0) return;

  const version = db.prepare('PRAGMA user_version').get().user_version;
  salir(
    'la base esta en el esquema v' + version + ' y le faltan ' + faltan.length +
    ' tablas que el punto cero necesita:' + '\n' +
    '  ' + faltan.join(', ') + '\n\n' +
    'El punto cero esta escrito para el esquema al dia. Para ponerla al dia:\n' +
    '  - Abra QualityTech POS una vez y cierrela: al arrancar aplica las\n' +
    '    migraciones pendientes y deja un respaldo automatico antes.\n' +
    '  - O promueva una base que ya este al dia, pasandole su ruta al .bat.\n' +
    'Despues vuelva a correr el instalador. No se toco nada.',
  );
}

function resumen(db) {
  const contar = (t) => {
    try { return db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n; }
    catch { return null; }
  };
  return {
    esquema: db.prepare('PRAGMA user_version').get().user_version,
    movimiento: {
      pedidos: contar('orders'),
      facturas: contar('bills'),
      'sesiones de caja': contar('cash_sessions'),
      'cierres Z': contar('cash_closures'),
      'mov. inventario': contar('stock_movements'),
      consecutivos: contar('sequences'),
    },
    negocio: {
      productos: contar('products'),
      categorías: contar('categories'),
      clientes: contar('customers'),
      proveedores: contar('suppliers'),
      usuarios: contar('users'),
      ajustes: contar('settings'),
    },
  };
}

function imprimirResumen(r) {
  console.log('  esquema: v' + r.esquema);
  console.log('  --- movimiento (debe quedar en cero) ---');
  for (const [k, v] of Object.entries(r.movimiento)) console.log('    ' + k.padEnd(18) + (v === null ? 'n/d' : v));
  console.log('  --- negocio (debe conservarse) ---');
  for (const [k, v] of Object.entries(r.negocio)) console.log('    ' + k.padEnd(18) + (v === null ? 'n/d' : v));
}

switch (orden) {
  case 'respaldar': {
    const [carpeta, destino] = args;
    if (!carpeta || !destino) salir('uso: respaldar <carpeta-datos> <carpeta-respaldos>');
    const db = rutaDb(carpeta);
    fs.mkdirSync(destino, { recursive: true });
    const archivo = path.join(destino, `flo-${marcaDeTiempo()}.db`);
    copiaLimpia(db, archivo);
    const mb = (fs.statSync(archivo).size / 1048576).toFixed(2);
    console.log('respaldo: ' + archivo + '  (' + mb + ' MB)');
    break;
  }

  case 'promover': {
    const [origen, carpeta] = args;
    if (!origen || !carpeta) salir('uso: promover <flo.db-origen> <carpeta-datos>');
    if (!fs.existsSync(origen)) salir('no existe el origen ' + origen);
    fs.mkdirSync(carpeta, { recursive: true });

    // El destino se deja limpio: si quedara un -wal viejo, SQLite intentaría
    // aplicarlo sobre la base nueva.
    for (const sufijo of ['', '-wal', '-shm']) {
      const f = path.join(carpeta, 'flo.db' + sufijo);
      if (fs.existsSync(f)) fs.rmSync(f);
    }
    copiaLimpia(origen, path.join(carpeta, 'flo.db'));

    const db = new DatabaseSync(path.join(carpeta, 'flo.db'), { open: true, readOnly: true });
    try {
      console.log('promovida. esquema v' + db.prepare('PRAGMA user_version').get().user_version +
        ', ' + db.prepare('SELECT COUNT(*) n FROM products').get().n + ' productos');
    } finally { db.close(); }
    break;
  }

  case 'puntocero': {
    const [carpeta, guion] = args;
    if (!carpeta || !guion) salir('uso: puntocero <carpeta-datos> <punto-cero.sql>');
    if (!fs.existsSync(guion)) salir('no existe el script ' + guion);
    const db = new DatabaseSync(rutaDb(carpeta), { open: true });
    try {
      const sql = fs.readFileSync(guion, 'utf8');
      comprobarEsquema(db, sql);

      const antes = resumen(db);
      try {
        db.exec(sql);
      } catch (e) {
        // Un volcado de Node no le sirve a quien esta instalando.
        salir('el borrado no se pudo completar: ' + e.message +
          '\nLa base quedo como estaba: el script corre dentro de una transaccion.');
      }
      const despues = resumen(db);

      const pendientes = Object.entries(despues.movimiento).filter(([, v]) => v !== null && v !== 0);
      if (pendientes.length) {
        salir('quedó movimiento sin borrar: ' + pendientes.map(([k, v]) => k + '=' + v).join(', '));
      }
      for (const [k, v] of Object.entries(despues.negocio)) {
        if (v !== null && v !== antes.negocio[k]) {
          salir('el negocio cambió en ' + k + ': ' + antes.negocio[k] + ' → ' + v);
        }
      }
      const integridad = db.prepare('PRAGMA integrity_check').get().integrity_check;
      if (integridad !== 'ok') salir('integridad: ' + integridad);
      const rotas = db.prepare('PRAGMA foreign_key_check').all();
      if (rotas.length) salir(rotas.length + ' referencias rotas tras el borrado');

      console.log('punto cero aplicado.');
      imprimirResumen(despues);
      console.log('  integridad: ok · referencias rotas: 0');
    } finally { db.close(); }
    break;
  }

  case 'verificar': {
    const [carpeta] = args;
    if (!carpeta) salir('uso: verificar <carpeta-datos>');
    const db = new DatabaseSync(rutaDb(carpeta), { open: true, readOnly: true });
    try {
      imprimirResumen(resumen(db));
      const integridad = db.prepare('PRAGMA integrity_check').get().integrity_check;
      console.log('  integridad: ' + integridad);
      if (integridad !== 'ok') process.exit(1);
    } finally { db.close(); }
    break;
  }

  default:
    salir('orden desconocida: ' + (orden || '(ninguna)') +
      '\n  use: respaldar | promover | puntocero | verificar');
}
