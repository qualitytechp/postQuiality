/**
 * `printBillForTenant` gates every automatic receipt print on the
 * "Autoimprimir comprobante" setting — its own description says it prints
 * "cuando se completa el pago" (when payment completes), with no carve-out for
 * checkout timing. `handlePrepaidCheckout` (the immediate-payment path used by
 * any prepaid tenant) used to pass a `force` flag that always evaluated to
 * `true`, silently bypassing the setting for that entire class of business —
 * turning it off had no effect, and a bare-bones setup with no thermal printer
 * configured would pop the browser print dialog on every single sale.
 *
 * This is a source-level guard rather than a rendered/interaction test because
 * exercising the real regression needs a live payment round-trip; it was
 * verified manually via Playwright (0 `popup` windows after confirming a
 * prepaid payment with the setting off) before writing this guard.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const posPage = readFileSync(
  resolve(process.cwd(), 'frontend/src/app/(dashboard)/pos/page.tsx'),
  'utf8',
);

console.log('Source guard: prepaid checkout print respects "Autoimprimir comprobante"');
console.log('='.repeat(70));

assert.match(
  posPage,
  /const printBillForTenant = async \(bill: Bill\) => \{/,
  'printBillForTenant takes no bypass parameter',
);
console.log('  ✓ printBillForTenant takes no bypass parameter');

assert.match(
  posPage,
  /if \(!autoPrintBill\) return;/,
  'the setting alone gates the print, unconditionally',
);
console.log('  ✓ the setting alone gates the print, unconditionally');

assert.doesNotMatch(
  posPage,
  /printBillForTenant\([^)]*,\s*\w/,
  'no caller passes a second argument that could bypass the setting again',
);
console.log('  ✓ no caller passes a second argument that could bypass the setting again');

console.log('\n' + '='.repeat(70));
console.log('3/3 passed, 0 failed');
