#!/usr/bin/env node
// knip ratchet: fail on unused files, exports or dependencies that are not in the committed baseline.
//
//   node scripts/knip-baseline.mjs           check; exit 1 on issues missing from scripts/knip-baseline.json
//   node scripts/knip-baseline.mjs --write   rewrite the baseline from the current tree
//
// knip has no baseline mode of its own. Two passes run with the repository's knip.json:
//   production  `knip --production`: files, exports and dependencies reachable only from production
//               entries (marked `!`), so code that only tests import counts as unused.
//   default     `knip --files --dependencies`: also covers root scripts/ and e2e/, which have no
//               production entries, for dead scripts and undeclared imports.
// Issues are keyed by type, file and name (not line), so moving code does not change the baseline.
// Fixed issues only print a note; run --write to drop them from the baseline.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(root, 'scripts/knip-baseline.json');
const knipBin = join(dirname(createRequire(import.meta.url).resolve('knip')), '..', 'bin', 'knip.js');
const common = ['--reporter', 'json', '--no-progress', '--no-config-hints', '--no-exit-code'];
const PASSES = {
  production: ['--production'],
  default: ['--files', '--dependencies'],
};

const byteCompare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const nameOf = (item) => (Array.isArray(item) ? item.map((entry) => entry.name).join('|') : item.name);

export function issueKeys(report) {
  const keys = (report.files ?? []).map((file) => `files\t${file}`);
  for (const issue of report.issues ?? []) {
    for (const [type, value] of Object.entries(issue)) {
      if (type === 'file' || type === 'owners' || type === 'files') continue;
      if (Array.isArray(value)) {
        for (const item of value) keys.push(`${type}\t${issue.file}\t${nameOf(item)}`);
      } else if (value && typeof value === 'object') {
        for (const [parent, members] of Object.entries(value)) {
          for (const item of members) keys.push(`${type}\t${issue.file}\t${parent}.${nameOf(item)}`);
        }
      }
    }
  }
  return [...new Set(keys)].sort(byteCompare);
}

function run(pass) {
  const output = execFileSync(process.execPath, [knipBin, ...PASSES[pass], ...common], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return issueKeys(JSON.parse(output));
}

function counts(keys) {
  const byType = {};
  for (const key of keys) {
    const type = key.slice(0, key.indexOf('\t'));
    byType[type] = (byType[type] ?? 0) + 1;
  }
  return Object.entries(byType).map(([type, total]) => `${type} ${total}`).join(', ') || 'none';
}

function main(argv) {
  const write = argv.includes('--write');
  const current = Object.fromEntries(Object.keys(PASSES).map((pass) => [pass, run(pass)]));
  if (write) {
    writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
    for (const pass of Object.keys(PASSES)) console.log(`knip ${pass}: wrote ${current[pass].length} baseline issues (${counts(current[pass])})`);
    return 0;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  let failed = false;
  for (const pass of Object.keys(PASSES)) {
    const allowed = new Set(baseline[pass] ?? []);
    const now = new Set(current[pass]);
    const added = current[pass].filter((key) => !allowed.has(key));
    const fixed = [...allowed].filter((key) => !now.has(key));
    console.log(`knip ${pass}: ${current[pass].length} issues, ${allowed.size} in baseline, ${added.length} new, ${fixed.length} fixed`);
    if (fixed.length) console.log(`  Fixed since the baseline (run \`node scripts/knip-baseline.mjs --write\` to drop them):\n    ${fixed.join('\n    ')}`);
    if (added.length) {
      failed = true;
      console.error(`  New knip issues (type, file, name):\n    ${added.join('\n    ')}`);
    }
  }
  if (failed) {
    console.error('\nDelete the unused code, use it, or declare the dependency. If knip is wrong, fix knip.json rather than the baseline.');
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
