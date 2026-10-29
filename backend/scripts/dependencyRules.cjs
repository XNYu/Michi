'use strict';
// Layer dependency ratchet.
//
// Records import edges that break a layering rule and compares them with the reviewed
// baseline in backend/test/fixtures/dependencyRules/edges.txt, so violations can shrink
// but not grow. Same scanner and fixture style as runtimeBoundary.cjs.
//
//   edges.txt   <rule>\t<from>\t<to>
//
// CLI (from the repository root):
//   node backend/scripts/dependencyRules.cjs           check; exit 1 on new edges
//   node backend/scripts/dependencyRules.cjs --write   rewrite the baseline

const fs = require('node:fs');
const path = require('node:path');
const boundary = require('./runtimeBoundary.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_FILE = path.join(REPO_ROOT, 'backend', 'test', 'fixtures', 'dependencyRules', 'edges.txt');

/** `from` files may not import `to` files. Globs use runtimeBoundary.cjs syntax; `!` excludes. */
const RULES = [
  {
    id: 'agents-to-db',
    from: ['backend/src/agents/**/*.ts', '!**/*.test.ts'],
    to: ['backend/src/services/db.ts'],
    reason: 'the agent layer reaches the database through repositories or injected ports, not the raw handle',
  },
  {
    id: 'agents-to-chatHub',
    from: ['backend/src/agents/**/*.ts', '!backend/src/agents/chatHub.ts', '!**/*.test.ts'],
    to: ['backend/src/agents/chatHub.ts'],
    reason: 'chatHub owns durable turns above the agent layer; agents report through ports and events',
  },
  {
    id: 'routes-to-db',
    from: ['backend/src/routes/**/*.ts', '!**/*.test.ts'],
    to: ['backend/src/services/db.ts'],
    reason: 'routes call repositories instead of running SQL on the raw handle',
  },
  {
    id: 'state-to-components',
    from: ['frontend/src/state/**/*.{ts,tsx}', '!**/*.test.{ts,tsx}'],
    to: ['frontend/src/components/**'],
    reason: 'frontend state is below the components that render it',
  },
];

const DESCRIBE = '<rule>\\t<from>\\t<to>: an import that breaks a layering rule';

function resolveTarget(source, root, file, specifier) {
  const target = boundary.resolveRepoModule(source, root, file, specifier);
  if (source.isFile(target)) return target;
  for (const suffix of ['.tsx', '/index.tsx']) {
    if (source.isFile(target + suffix)) return target + suffix;
  }
  return target;
}

/** @returns {string[]} byte-sorted edge lines */
function scan(repoRoot, rules = RULES) {
  const root = path.resolve(repoRoot);
  const source = boundary.fsSource(root);
  const compiled = rules.map((rule) => ({
    ...rule,
    isFrom: boundary.createMatcher(rule.from),
    isTo: boundary.createMatcher(rule.to),
  }));
  const files = boundary.sortedUnique(boundary.scanRoots(rules.flatMap((rule) => rule.from)).flatMap((dir) => source.list(dir)))
    .filter((file) => compiled.some((rule) => rule.isFrom(file)));
  const contents = source.readAll(files);
  const edges = [];
  for (const file of files) {
    const applicable = compiled.filter((rule) => rule.isFrom(file));
    for (const specifier of boundary.moduleSpecifiers(boundary.parse(file, contents.get(file)))) {
      if (boundary.classifySpecifier(specifier) !== 'repo') continue;
      const target = resolveTarget(source, root, file, specifier);
      for (const rule of applicable) {
        if (rule.isTo(target)) edges.push(`${rule.id}\t${file}\t${target}`);
      }
    }
  }
  return boundary.sortedUnique(edges);
}

function loadFixture(file = FIXTURE_FILE) {
  const ruleIds = new Set(RULES.map((rule) => rule.id));
  const lines = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((raw, index) => {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.startsWith('#')) return;
    const columns = line.split('\t');
    if (columns.length !== 3 || columns.some((column) => column === '') || !ruleIds.has(columns[0])) {
      throw new Error(`${path.basename(file)}:${index + 1}: expected ${DESCRIBE}, got ${JSON.stringify(line)}`);
    }
    lines.push(line);
  });
  return boundary.sortedUnique(lines);
}

function compare(current, fixture) {
  const now = new Set(current);
  const allowed = new Set(fixture);
  return {
    added: current.filter((line) => !allowed.has(line)),
    stale: fixture.filter((line) => !now.has(line)),
  };
}

function counts(edges) {
  return RULES.map((rule) => `${rule.id} ${edges.filter((line) => line.startsWith(`${rule.id}\t`)).length}`).join(', ');
}

function writeFixture(current, file = FIXTURE_FILE) {
  const header = [
    '# Layer dependency baseline (backend/scripts/dependencyRules.cjs).',
    `# ${DESCRIBE}`,
    '# One entry per line, byte-sorted; # lines are comments. New entries fail',
    '# npm run check:deps and backend/test/dependencyRules.test.ts. Remove entries as edges go away.',
    '# Regenerate with: node backend/scripts/dependencyRules.cjs --write',
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${[...header, ...current].join('\n')}\n`);
}

function formatAdded(added) {
  const reasons = RULES.filter((rule) => added.some((line) => line.startsWith(`${rule.id}\t`)))
    .map((rule) => `  ${rule.id}: ${rule.reason}`);
  return [`New layer dependency edges:\n${added.join('\n')}`, `Rules:\n${reasons.join('\n')}`,
    'Move the code to the right layer or inject the dependency. If an edge is unavoidable, add it to\n'
    + 'backend/test/fixtures/dependencyRules/edges.txt and give the reason in the commit message.'].join('\n\n');
}

function main(argv) {
  const started = Date.now();
  const current = scan(REPO_ROOT);
  if (argv.includes('--write')) {
    writeFixture(current);
    console.log(`Wrote ${path.relative(REPO_ROOT, FIXTURE_FILE)}: ${counts(current)}`);
    return 0;
  }
  const { added, stale } = compare(current, loadFixture());
  console.log(`layer dependencies: ${counts(current)} (${Date.now() - started}ms)`);
  if (stale.length) console.log(`\nStale baseline entries (no longer present; run with --write to drop them):\n${stale.join('\n')}`);
  if (added.length) {
    console.error(`\n${formatAdded(added)}`);
    return 1;
  }
  return 0;
}

module.exports = { RULES, scan, loadFixture, compare, writeFixture };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
