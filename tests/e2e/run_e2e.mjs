#!/usr/bin/env node
/**
 * Zero-dependency Node.js v24 E2E Test Runner for Cr-PDF (Tiers 1–4).
 *
 * Usage:
 *   node tests/e2e/run_e2e.mjs [options]
 *
 * Options:
 *   --tier <1|2|3|4|all>   Tier(s) to run or list (default: all; comma-separated e.g. 1,2 allowed)
 *   --list                 Dry-run: print all matching tiers, feature areas, test IDs & counts; exit 0
 *   --filter <regex>       Filter tests by ID, feature, or title (case-insensitive RegExp)
 *   --timeout <ms>         Per-test timeout in milliseconds (default: 30000)
 *   --json <path>          Write structured JSON report to <path>
 *   --bin <path>           Override Cr-PDF binary path (default: CRPDF_BIN or ./build/cr-pdf)
 *   --fail-fast            Stop immediately after the first failing test
 *   --help                 Show usage information
 *
 * Exit codes:
 *   0: --list completed, OR all selected tests passed (failed === 0 && total > 0)
 *   1: One or more tests failed, OR --filter matched 0 tests
 *   2: Invalid CLI flags, invalid --filter regex, or missing binary in live execution mode
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveBinaryPath } from './harness.mjs';
import { tests as tier1Tests } from './tier1_features.mjs';
import { tests as tier2Tests } from './tier2_boundaries.mjs';
import { tests as tier3Tests } from './tier3_pairwise.mjs';
import { tests as tier4Tests } from './tier4_scenarios.mjs';

const ALL_TIERS = new Map([
  [1, { name: 'Tier 1: Feature Coverage', tests: tier1Tests }],
  [2, { name: 'Tier 2: Boundary & Corner Cases', tests: tier2Tests }],
  [3, { name: 'Tier 3: Cross-Feature Pairwise', tests: tier3Tests }],
  [4, { name: 'Tier 4: Real-World Application Scenarios', tests: tier4Tests }],
]);

function printUsage() {
  console.log(`Cr-PDF Opaque-Box E2E Test Runner (Node.js v24)

Usage:
  node tests/e2e/run_e2e.mjs [options]

Options:
  --tier <1|2|3|4|all>   Tier(s) to select (default: all; comma-separated e.g. 1,2)
  --list                 Dry-run: print matching tiers, areas, test IDs & counts (no binary required)
  --filter <regex>       Case-insensitive RegExp matching test ID, feature, or title
  --timeout <ms>         Per-test timeout in ms (default: 30000)
  --json <path>          Write structured JSON report to <path>
  --bin <path>           Override Cr-PDF binary path (default: CRPDF_BIN or ./build/cr-pdf)
  --fail-fast            Abort on first test failure
  --help                 Print this help message
`);
}

function parseTierSelection(rawTier) {
  if (!rawTier || rawTier.toLowerCase() === 'all') {
    return [1, 2, 3, 4];
  }
  const parts = rawTier
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const selected = new Set();
  for (const p of parts) {
    const num = Number.parseInt(p, 10);
    if (!Number.isInteger(num) || !ALL_TIERS.has(num)) {
      throw new Error(`Invalid --tier value "${p}". Expected 1, 2, 3, 4, or all.`);
    }
    selected.add(num);
  }
  return [...selected].sort((a, b) => a - b);
}

async function runWithTimeout(fn, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Test timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function printList(selectedTests) {
  const byTier = new Map();
  for (const t of selectedTests) {
    if (!byTier.has(t.tier)) byTier.set(t.tier, []);
    byTier.get(t.tier).push(t);
  }

  console.log('=== Cr-PDF E2E Test Suite Inventory ===');
  for (const tierNum of [...byTier.keys()].sort((a, b) => a - b)) {
    const meta = ALL_TIERS.get(tierNum);
    const list = byTier.get(tierNum);
    console.log(`\n${meta.name} (${list.length} tests)`);

    const byFeature = new Map();
    for (const t of list) {
      if (!byFeature.has(t.feature)) byFeature.set(t.feature, []);
      byFeature.get(t.feature).push(t);
    }
    for (const [feature, items] of byFeature.entries()) {
      console.log(`  [${feature}] (${items.length})`);
      for (const item of items) {
        const mode = item.requiresBinary ? 'live-app' : 'standalone-cli';
        console.log(`    - ${item.id} (${mode}): ${item.title}`);
      }
    }
  }

  console.log('\n=== Summary Counts ===');
  for (const tierNum of [1, 2, 3, 4]) {
    if (byTier.has(tierNum)) {
      console.log(`  Tier ${tierNum}: ${byTier.get(tierNum).length}`);
    }
  }
  console.log(`  Total : ${selectedTests.length}`);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        tier: { type: 'string', default: 'all' },
        list: { type: 'boolean', default: false },
        filter: { type: 'string' },
        timeout: { type: 'string', default: '30000' },
        json: { type: 'string' },
        bin: { type: 'string' },
        'fail-fast': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`CLI argument error: ${err.message}`);
    process.exit(2);
  }

  const opts = parsed.values;
  if (opts.help) {
    printUsage();
    process.exit(0);
  }

  let selectedTierNums;
  try {
    selectedTierNums = parseTierSelection(opts.tier);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  let filterRegex = null;
  if (opts.filter) {
    try {
      filterRegex = new RegExp(opts.filter, 'i');
    } catch (err) {
      console.error(`Invalid --filter regex "${opts.filter}": ${err.message}`);
      process.exit(2);
    }
  }

  const defaultTimeoutMs = Number.parseInt(opts.timeout, 10);
  if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
    console.error(`Invalid --timeout value "${opts.timeout}". Expected positive integer ms.`);
    process.exit(2);
  }

  let selectedTests = [];
  for (const tierNum of selectedTierNums) {
    selectedTests.push(...ALL_TIERS.get(tierNum).tests);
  }

  if (filterRegex) {
    selectedTests = selectedTests.filter(
      (t) => filterRegex.test(t.id) || filterRegex.test(t.feature) || filterRegex.test(t.title),
    );
  }

  if (opts.list) {
    printList(selectedTests);
    process.exit(0);
  }

  if (selectedTests.length === 0) {
    console.error('No tests matched the given --tier / --filter criteria.');
    process.exit(1);
  }

  const binPath = resolveBinaryPath(opts.bin);
  const needsBinary = selectedTests.some((t) => t.requiresBinary);
  if (needsBinary && !fs.existsSync(binPath)) {
    console.error(
      `ERROR: Cr-PDF binary not found at "${binPath}".\n` +
        `Live E2E tests cannot pass without a compiled binary. Build ./build/cr-pdf or pass --bin <path> / CRPDF_BIN.`,
    );
    process.exit(2);
  }

  const startedAt = new Date().toISOString();
  const results = [];
  let passed = 0;
  let failed = 0;

  console.log(`Running ${selectedTests.length} Cr-PDF E2E tests (bin=${binPath})...\n`);

  for (const testCase of selectedTests) {
    const t0 = Date.now();
    const timeoutMs = testCase.timeoutMs ?? defaultTimeoutMs;
    try {
      await runWithTimeout(
        () => testCase.run({ binPath, timeoutMs }),
        timeoutMs,
      );
      const durationMs = Date.now() - t0;
      passed++;
      results.push({
        id: testCase.id,
        tier: testCase.tier,
        feature: testCase.feature,
        title: testCase.title,
        status: 'passed',
        durationMs,
      });
      console.log(`  PASS  ${testCase.id} (${durationMs}ms) — ${testCase.title}`);
    } catch (err) {
      const durationMs = Date.now() - t0;
      failed++;
      const message = err?.stack || err?.message || String(err);
      results.push({
        id: testCase.id,
        tier: testCase.tier,
        feature: testCase.feature,
        title: testCase.title,
        status: 'failed',
        durationMs,
        error: message,
      });
      console.error(`  FAIL  ${testCase.id} (${durationMs}ms) — ${testCase.title}`);
      console.error(`        ${err?.message || err}`);
      if (opts['fail-fast']) {
        console.error('\nStopping early due to --fail-fast.');
        break;
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const summary = {
    startedAt,
    finishedAt,
    binPath,
    tiers: selectedTierNums,
    filter: opts.filter || null,
    total: results.length,
    passed,
    failed,
    results,
  };

  if (opts.json) {
    const outPath = path.resolve(opts.json);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
    console.log(`\nJSON report written to ${outPath}`);
  }

  console.log(`\n=== E2E Results: ${passed} passed, ${failed} failed, ${results.length} total ===`);
  process.exit(failed === 0 && results.length > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`Fatal E2E runner error: ${err?.stack || err}`);
  process.exit(2);
});
