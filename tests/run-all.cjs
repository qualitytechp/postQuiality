/**
 * Lista canónica y ordenada de la suite principal, y su ejecutor.
 *
 * Antes esta lista vivía como una cadena de ~140 `&&` dentro del script `test`
 * de package.json. Llegó a 8.190 caracteres y cmd.exe corta en 8.191, así que en
 * Windows —la plataforma principal de este POS— `npm test` moría con "La línea de
 * comandos es demasiado larga" antes de ejecutar un solo test; en Linux pasaba
 * solo porque su límite es mucho mayor. Aquí no hay techo.
 *
 * Sigue habiendo UNA sola lista: este módulo la exporta y la leen tanto el
 * particionador de CI (`scripts/ci/run-test-shard.cjs`) como el guardián en
 * `tests/dev-tooling-scripts.test.ts`. Al agregar una suite, agréguela aquí.
 *
 * Se conserva el comportamiento anterior: se detiene en el primer fallo, y el
 * código de salida 77 (desajuste de ABI) cuenta como omitido, no como error.
 *
 * Uso:
 *   node tests/run-all.cjs               se detiene en el primer fallo
 *   node tests/run-all.cjs --keep-going  las corre todas y resume al final
 */
const { spawnSync } = require('node:child_process');

const SUITES = [
  'test:smoke',
  'test:server-port-collision',
  'test:kds-integration',
  'test:kds-contract',
  'test:kds-frontend-conflict',
  'test:kds-window-hardening',
  'test:electron-api-contract',
  'test:titlebar-window-options',
  'test:window-readiness',
  'test:window-load-retry',
  'test:cors',
  'test:csp-lan',
  'test:release-config',
  'test:update-channel',
  'test:telemetry',
  'test:country-provenance',
  'test:first-run',
  'test:phase7-setup-i18n',
  'test:security',
  'test:staff-authz',
  'test:orders-authz',
  'test:authz-phase3',
  'test:auth-ui-deterministic',
  'test:customer-auth',
  'test:customer-pagination',
  'test:backup',
  'test:issue-278-fail-closed-db',
  'test:recovery-cloud',
  'test:cloud-account-status',
  'test:printer',
  'test:printer-width-refresh',
  'test:printer-migrations',
  'test:print-parity',
  'test:thermal-capabilities',
  'test:raster',
  'test:merchant-print-templates',
  'test:merchant-template-transfer',
  'test:print-document',
  'test:print-kernel',
  'test:translations',
  'test:print-labels',
  'test:locale-chunks',
  'test:rtl-foundation',
  'test:rtl-setup-auth-settings',
  'test:rtl-dashboard-pos-common',
  'test:rtl-kds-server-whatsapp',
  'test:phone',
  'test:country-localization',
  'test:currency',
  'test:tax-engine',
  'test:tax-components',
  'test:tax-pack-catalog',
  'test:tax-pack-management',
  'test:manual-tax-config',
  'test:legacy-tax-pack-digest',
  'test:community-tax-packs',
  'test:support-ticket',
  'test:customer-phone-search',
  'test:customer-document-search',
  'test:phone-search-integration',
  'test:receipt-column-width',
  'test:notes-validation',
  'test:receipt-printing',
  'test:cancel-override',
  'test:refunds',
  'test:cash-closures',
  'test:cash-sessions',
  'test:report-builder',
  'test:kitchen-addons',
  'test:order-item-addons',
  'test:addon-group-enforcement',
  'test:issue-122-addon-quantities',
  'test:issue-245-246-addon-groups',
  'test:issue-247-catalog-invariants',
  'test:issue-125-addon-reads',
  'test:windows-country-code-crash',
  'test:reports-insights',
  'test:reports-daily-stats-table-turn',
  'test:timezone-report-boundaries',
  'test:sequence',
  'test:integration-happy',
  'test:integration-tax',
  'test:integration-payments',
  'test:issue-214',
  'test:issue-214-auth',
  'test:issue-214-migration',
  'test:integration-lifecycle',
  'test:integration-reconciliation',
  'test:integration-loyalty',
  'test:integration-discount',
  'test:loyalty-toggle',
  'test:modules-toggle',
  'test:discount-system',
  'test:integration-discount-settings',
  'test:integration-loyalty-global',
  'test:issue-248-csv',
  'test:menu-csv-weighted',
  'test:weight-input',
  'test:pos-prepaid-print-respects-setting',
  'test:bill-items-weight-unit',
  'test:x-report-bill-detail',
  'test:integration-loyalty-redemption',
  'test:bills-print-api',
  'test:issue-24',
  'test:issue-134-routing',
  'test:issue-134-mgmt',
  'test:issue-137-barcode',
  'test:issue-244-product-addon-links',
  'test:issue-250-catalog-perf',
  'test:issue-252',
  'test:stock-ledger',
  'test:purchases',
  'test:purchases-hardening',
  'test:purchases-edit',
  'test:receivables',
  'test:cartera',
  'test:issue-258-bill-pagination',
  'test:issue-265-morocco-profile',
  'test:issue-266-currency-symbol-print',
  'test:tables-string-ids',
  'test:held-orders',
  'test:schema-health',
  'test:upgrade-path',
  'test:upgrade-matrix-harness',
  'test:migration-v56-v57',
  'test:migration-v71-repair',
  'test:migration-v80-cash-drawer-pulse',
  'test:migration-v81-cash-closures',
  'test:master-pin',
  'test:google-drive',
  'test:database-tools-api',
  'test:phone-validation',
  'test:phone-migration',
  'test:issue-133-kds-kot-toggles',
  'test:whatsapp-schema',
  'test:whatsapp-service',
  'test:whatsapp-middleware',
  'test:issue-127-password-recovery',
  'test:dev-tooling',
  'test:windows-uninstaller',
  'test:shutdown-lifecycle',
  'test:redos-hardening',
  'test:startup-cache',
  'test:service-worker',
  'test:issue-389-timezone-override',
  'test:issue-390-locale-preference-invariants',
  'test:issue-475-picker-highlight',
  'test:theme-mode-settings',
  'test:theme-fouc-script',
  'test:ui-regressions-621-623-626',
];

module.exports = { SUITES };

// En Windows npm es un .cmd y Node no lo puede lanzar sin shell; pero pasar un
// array de argumentos junto a `shell: true` está deprecado (DEP0190) porque no
// se escapan. Se manda entonces una sola cadena, y como los nombres salen de la
// constante de arriba, este guardia deja explícito que nada externo entra ahí.
const NOMBRE_VALIDO = /^test:[A-Za-z0-9:-]+$/;

function correr() {
  const seguir = process.argv.includes('--keep-going');
  const fallidas = [];
  const omitidas = [];

  for (let i = 0; i < SUITES.length; i++) {
    const suite = SUITES[i];
    if (!NOMBRE_VALIDO.test(suite)) {
      console.error('Nombre de suite inválido en la lista: ' + suite);
      process.exit(2);
    }
    console.log('\n[' + (i + 1) + '/' + SUITES.length + '] ' + suite);

    const r = process.platform === 'win32'
      ? spawnSync('npm run ' + suite, { stdio: 'inherit', shell: true })
      : spawnSync('npm', ['run', suite], { stdio: 'inherit' });

    if (r.status === 77) {
      omitidas.push(suite);
      console.log('  ⏭ Omitida (desajuste de ABI)');
      continue;
    }
    if (r.error) {
      fallidas.push(suite);
      console.error('  ✖ No se pudo lanzar: ' + r.error.message);
    } else if (r.status !== 0) {
      fallidas.push(suite);
      console.error('  ✖ Falló con código ' + r.status);
    }
    if (fallidas.length && !seguir) break;
  }

  console.log('\n' + '='.repeat(62));
  console.log(
    'suites: ' + SUITES.length +
    ' | omitidas: ' + omitidas.length +
    ' | fallidas: ' + fallidas.length
  );
  if (fallidas.length) {
    console.log('fallaron: ' + fallidas.join(', '));
    process.exit(1);
  }
  console.log('todo en verde');
}

// Solo ejecuta al invocarlo directamente; importarlo debe dar la lista y nada más.
if (require.main === module) correr();
