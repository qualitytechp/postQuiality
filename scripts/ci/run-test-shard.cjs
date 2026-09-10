#!/usr/bin/env node
/*
 * CI test sharding for the FloCafe "Core test suite" (`npm test`).
 *
 * La lista canónica y ordenada vive en `tests/run-all.cjs`, que es lo mismo que
 * ejecuta `npm test`. Este ayudante la importa en tiempo de ejecución (para que
 * no haya una segunda lista que se desincronice), reparte las suites entre
 * shards por posición (round-robin) y corre el subconjunto de este shard con el
 * mismo envoltorio `run-test.sh` que usa `npm test`.
 *
 * Usage:
 *   SHARD_TOTAL=2 SHARD_INDEX=0 node scripts/ci/run-test-shard.cjs
 *
 * The `pretest` hook (test:payment-methods-split) is intentionally NOT run here;
 * CI runs it as its own step before the shards, mirroring `npm test`'s pretest.
 */

'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

function parseIntEnv(name, value, fallback, min) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    console.error(`Invalid ${name}=${value}: expected an integer >= ${min}.`);
    process.exit(2);
  }
  return n;
}

const total = parseIntEnv('SHARD_TOTAL', process.env.SHARD_TOTAL, 2, 1);
const index = parseIntEnv('SHARD_INDEX', process.env.SHARD_INDEX, 0, 0);
if (index >= total) {
  console.error(`Invalid SHARD_INDEX=${index}: must be < SHARD_TOTAL=${total}.`);
  process.exit(2);
}

const { SUITES } = require(path.join(__dirname, '..', '..', 'tests', 'run-all.cjs'));

const suites = [];
for (const suite of SUITES) {
  if (!suites.includes(suite)) suites.push(suite);
}

if (suites.length === 0) {
  console.error('tests/run-all.cjs no exportó ninguna suite para repartir.');
  process.exit(2);
}

const mine = suites.filter((_, i) => i % total === index);
console.log(
  `[test-shard] shard ${index}/${total}: ${mine.length}/${suites.length} suites (total across shards).`,
);

let failed = false;
for (const suite of mine) {
  console.log(`\n=== [shard ${index}] ${suite} ===`);
  const result = spawnSync('bash', ['tests/run-test.sh', 'npm', 'run', suite], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error || result.signal || result.status !== 0) {
    console.error(`[shard ${index}] FAILED: ${suite}`);
    failed = true;
    break;
  }
}

process.exit(failed ? 1 : 0);
