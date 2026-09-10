/**
 * Lanza un test que necesita Electron de verdad (con Chromium), no Electron en
 * modo Node.
 *
 * El resto de tests de Electron del repo exportan ELECTRON_RUN_AS_NODE=1 a
 * propósito, y algunas terminales integradas (VS Code, entre otras) también la
 * exportan al entorno. Si se hereda aquí, el binario arranca como Node: entonces
 * `require('electron')` devuelve una ruta en vez del módulo, `app` queda
 * undefined y el fallo aparece como un TypeError sin relación aparente. Borrarla
 * explícitamente evita ese diagnóstico engañoso.
 */
const { spawnSync } = require('node:child_process');
const electronPath = require('electron');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Uso: node tests/run-electron-gui-test.cjs <archivo-de-test> [args...]');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const result = spawnSync(electronPath, ['--no-sandbox', ...args], {
  stdio: 'inherit',
  env,
  timeout: 600_000,
});

if (result.error) {
  console.error('[test-runner] No se pudo lanzar Electron:', result.error.message);
  process.exit(1);
}
if (result.signal) {
  console.error(`[test-runner] Electron terminó por señal: ${result.signal}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
