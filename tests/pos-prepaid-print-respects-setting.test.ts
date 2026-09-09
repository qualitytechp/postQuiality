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
 * Also guards a second regression found while verifying the first fix: the
 * bill object handed to `printBillForTenant` here (`paidBill`, straight from
 * `/bills/:id/payments`) never carries `order.items` — that endpoint's response
 * is `{ bill }` only, no nested order. Every immediate-payment receipt was
 * printing with an empty item table, for every prepaid tenant, since before
 * this fix. `handlePaymentComplete` (the postpaid sibling) already re-fetches
 * the full bill before printing; this call site now does the same.
 *
 * This is a source-level guard rather than a rendered/interaction test because
 * exercising the real regression needs a live payment round-trip; both were
 * verified manually via Playwright (0 `popup` windows with the setting off;
 * the printed item table populated with a real product) before writing this.
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

assert.match(
  posPage,
  /await printBillForTenant\(await fetchLatestBill\(paidBill\.id\)\)/,
  'the prepaid checkout re-fetches the full bill before printing, so the receipt has its items',
);
console.log('  ✓ the prepaid checkout re-fetches the full bill before printing, so the receipt has its items');

console.log('\n' + '='.repeat(70));
console.log('4/4 passed, 0 failed');

// Top-level export: makes this a module, not a global script, so its
// boilerplate names stop colliding with every other script-style test file
// under tsc's whole-project view. No import consumers; harmless at runtime.
export {};
