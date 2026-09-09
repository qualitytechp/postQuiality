/**
 * Manual weight entry for products sold by kg/g/lb.
 *
 * The load-bearing assertion is the last block: whatever `parseWeightInput`
 * hands to the cart must be accepted by the backend's `validateProductQuantity`.
 * If those two ever drift, the cashier types a weight and the sale fails at
 * checkout, so they are checked against each other rather than in isolation.
 */
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.join(__dirname, '..');
const moduleApi = require('module') as { _resolveFilename: (...args: any[]) => string };
const originalResolveFilename = moduleApi._resolveFilename;
moduleApi._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
  const resolved = request.startsWith('@/')
    ? path.resolve(ROOT, 'frontend/src', request.slice(2))
    : request;
  return originalResolveFilename.call(this, resolved, parent, isMain, options);
};

const {
  isWeighedProduct,
  clampWeightPrecision,
  acceptsWeightKeystroke,
  clampWeightValue,
  parseWeightInput,
  quickWeightValues,
  maxWeightFor,
  formatWeight,
} = require('../frontend/src/lib/weight-input');
const { validateProductQuantity } = require('../main/routes/orders-validation');

let passed = 0;
let failed = 0;
function check(label: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (error: any) {
    failed++;
    console.log(`  ✗ ${label}\n      ${error.message}`);
  }
}

console.log('Weight input for weighed products');
console.log('='.repeat(58));

console.log('\n─── Which products are weighed ───');
check('needs both a weight unit and fractional quantities', () => {
  assert.equal(isWeighedProduct({ sale_unit: 'kg', allow_fractional_quantity: true }), true);
  assert.equal(isWeighedProduct({ sale_unit: 'kg', allow_fractional_quantity: false }), false);
  assert.equal(isWeighedProduct({ sale_unit: 'each', allow_fractional_quantity: true }), false);
});
check('g and lb count as weighed, each does not', () => {
  for (const unit of ['kg', 'g', 'lb']) {
    assert.equal(isWeighedProduct({ sale_unit: unit, allow_fractional_quantity: true }), true, unit);
  }
  assert.equal(isWeighedProduct({ sale_unit: 'each', allow_fractional_quantity: true }), false);
});
check('missing or malformed products are not weighed', () => {
  assert.equal(isWeighedProduct(null), false);
  assert.equal(isWeighedProduct(undefined), false);
  assert.equal(isWeighedProduct({}), false);
});

console.log('\n─── Precision ───');
check('defaults to 3 and clamps to the backend range', () => {
  assert.equal(clampWeightPrecision(undefined), 3);
  assert.equal(clampWeightPrecision(null), 3);
  assert.equal(clampWeightPrecision(2.5), 3, 'a non-integer falls back to the default');
  assert.equal(clampWeightPrecision(-1), 0);
  assert.equal(clampWeightPrecision(9), 4);
});

console.log('\n─── Keystrokes the pad accepts ───');
check('a half-typed decimal stays typeable', () => {
  assert.equal(acceptsWeightKeystroke('', 3), true);
  assert.equal(acceptsWeightKeystroke('0.', 3), true);
  assert.equal(acceptsWeightKeystroke('.', 3), true);
});
check('more decimals than the product allows are refused', () => {
  assert.equal(acceptsWeightKeystroke('0.750', 3), true);
  assert.equal(acceptsWeightKeystroke('0.7501', 3), false);
  assert.equal(acceptsWeightKeystroke('0.7', 0), false, 'precision 0 admits no decimals at all');
});
check('non-numeric text is refused', () => {
  assert.equal(acceptsWeightKeystroke('1kg', 3), false);
  assert.equal(acceptsWeightKeystroke('-1', 3), false);
  assert.equal(acceptsWeightKeystroke('1.2.3', 3), false);
});

console.log('\n─── Parsing ───');
check('zero and blanks yield no weight', () => {
  assert.equal(parseWeightInput('', 3), null);
  assert.equal(parseWeightInput('0', 3), null);
  assert.equal(parseWeightInput('0.000', 3), null);
  assert.equal(parseWeightInput('.', 3), null);
});
check('a typed weight parses to its number', () => {
  assert.equal(parseWeightInput('0.75', 3), 0.75);
  assert.equal(parseWeightInput('1', 3), 1);
  assert.equal(parseWeightInput('250', 0), 250);
});
check('the result is rounded to the product precision', () => {
  assert.equal(parseWeightInput('0.75', 1), 0.8);
  assert.equal(parseWeightInput('1.25', 0), 1);
});

console.log('\n─── Typo guard on the physical keyboard ───');
check('the same cap the touch pad enforces applies to typed input', () => {
  assert.equal(clampWeightValue('1500', maxWeightFor('kg')), '999');
  assert.equal(clampWeightValue('50', maxWeightFor('kg')), '50', 'a value under the cap is untouched');
});
check('a half-typed decimal is left alone so it stays typeable', () => {
  assert.equal(clampWeightValue('', 999), '');
  assert.equal(clampWeightValue('.', 999), '.');
});
check('non-numeric text is returned unchanged, not silently zeroed', () => {
  assert.equal(clampWeightValue('abc', 999), 'abc');
});

console.log('\n─── Counter shortcuts ───');
check('quick values follow the unit', () => {
  assert.deepEqual(quickWeightValues('kg'), ['0.25', '0.5', '1', '2']);
  assert.deepEqual(quickWeightValues('g'), ['100', '250', '500', '1000']);
  assert.deepEqual(quickWeightValues('lb'), ['0.5', '1', '2', '5']);
});
check('every quick value parses back to a usable weight', () => {
  for (const unit of ['kg', 'g', 'lb']) {
    for (const quick of quickWeightValues(unit)) {
      const parsed = parseWeightInput(quick, 3);
      assert.ok(parsed !== null && parsed > 0, `${unit} ${quick}`);
      assert.ok(parsed <= maxWeightFor(unit), `${unit} ${quick} is within the typo guard`);
    }
  }
});

console.log('\n─── Display ───');
check('the weight shows the product decimals', () => {
  assert.equal(formatWeight(0.75, 3, 'en-US'), '0.750');
  assert.equal(formatWeight(0.75, 3, 'es-CO'), '0,750');
  assert.equal(formatWeight(2, 0, 'en-US'), '2');
});

console.log('\n─── Agreement with the backend validator ───');
check('every parsed weight is accepted by validateProductQuantity', () => {
  const inputs = ['0.75', '1', '0.001', '12.5', '999', '0.1', '3.333'];
  for (const precision of [0, 1, 2, 3, 4]) {
    for (const raw of inputs) {
      const parsed = parseWeightInput(raw, precision);
      if (parsed === null) continue;
      const product = {
        name: 'Weighed', sale_unit: 'kg', allow_fractional_quantity: 1, weight_precision: precision,
      };
      assert.doesNotThrow(
        () => validateProductQuantity(product, parsed),
        `precision ${precision} rejected "${raw}" parsed as ${parsed}`,
      );
    }
  }
});
check('an over-precise reading is rounded, never passed through raw', () => {
  const product = { name: 'Weighed', sale_unit: 'kg', allow_fractional_quantity: 1, weight_precision: 3 };
  assert.throws(() => validateProductQuantity(product, 0.7501), 'the backend refuses the raw reading');
  assert.equal(acceptsWeightKeystroke('0.7501', 3), false, 'the pad refuses to type it');
  assert.equal(parseWeightInput('0.7501', 3), 0.75, 'a scale reading is rounded to the product precision');
  assert.doesNotThrow(() => validateProductQuantity(product, parseWeightInput('0.7501', 3)));
});
check('a weight that rounds away to zero is not a sale', () => {
  assert.equal(parseWeightInput('0.001', 0), null);
  assert.equal(parseWeightInput('0.0004', 3), null);
});
check('weights are refused for products that are not weighed', () => {
  const product = { name: 'Plain', sale_unit: 'each', allow_fractional_quantity: 0, weight_precision: 3 };
  assert.equal(isWeighedProduct(product as any), false, 'the pad never opens for it');
  assert.throws(() => validateProductQuantity(product, 0.75), 'and the backend refuses a fraction anyway');
});

console.log('\n' + '='.repeat(58));
console.log(`${passed}/${passed + failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

// Top-level export: makes this a module, not a global script, so its
// boilerplate names stop colliding with every other script-style test file
// under tsc's whole-project view. No import consumers; harmless at runtime.
export {};
