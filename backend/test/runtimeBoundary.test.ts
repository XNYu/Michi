import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

type Entries = { imports: string[]; env: string[]; runtimeIds: string[] };
type Comparison = { added: Entries; stale: Entries; hasAdded: boolean };
interface RuntimeBoundary {
  CANDIDATE_GLOBS: string[];
  RUNTIME_ID_GLOBS: string[];
  KINDS: Array<{ key: keyof Entries; file: string; label: string }>;
  REMEDIATION: string;
  scan(repoRoot: string, options?: { ref?: string }): Entries;
  loadFixture(dir: string, options?: { baseline?: boolean; pending?: boolean }): Entries;
  compare(current: Entries, fixture: Entries): Comparison;
}

// The scanner is a CommonJS build script (backend/scripts), not part of src/.
const boundary = require('../scripts/runtimeBoundary.cjs') as RuntimeBoundary;

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'runtimeBoundary');
const GIT = fs.existsSync('/usr/bin/git') ? '/usr/bin/git' : 'git';

function writeTree(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

function tempRepo(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const MINI_REPO: Record<string, string> = {
  // Candidate (top-level runtime file): re-exports reach app code.
  'backend/src/agents/registry.ts': [
    "import { thing } from '../../../runtime/src/adapters/crew/crewThing';",
    "export type { AppType } from '../services/appTypes';",
    "export * from '../services/reexport';",
    'export const used = thing;',
  ].join('\n'),
  // Candidate (package adapter directory): every import form and resolution
  // rule. Its imports into backend/ count even when they reach a candidate.
  'runtime/src/adapters/crew/CrewAdapter.ts': [
    "import fs from 'node:fs';",
    "import path from 'path';",
    "import { readFile } from 'fs/promises';",
    "import { shared } from 'michi-shared';",
    "import ts from 'typescript';",
    "import { a } from '../../../../backend/src/services/dbRepository';",
    "import type { T } from '../../../../backend/src/services/dbTypes';",
    "import { b } from '../../../../backend/src/services/dbRepository';",
    "import '../../../../backend/src/services/sideEffect';",
    "import legacy = require('../../../../backend/src/services/legacy');",
    "import { thing } from './crewThing';",
    "import { registry } from '../../../../backend/src/agents/sessionRegistry';",
    "import { hub } from '../../../../backend/src/agents/chatHub';",
    "import { gen } from '../codex/gen/v2';",
    "import { both } from '../../../../backend/src/services/both';",
    "import { root } from '../../../../shared/src/index';",
    "const lazy = require('../../../../backend/src/services/lazy');",
    "const data = require('../../../../backend/src/services/data.json');",
    "const settings = require('../../../../backend/src/services/settings');",
    "const dyn = import('../../../../backend/src/services/dyn');",
    "type Only = typeof import('../../../../backend/src/services/typeOnly');",
    "const missing = require('../../../../backend/src/services/missing');",
    "const esm = require('../../../../backend/src/services/esmStyle.js');",
    "const name = 'x';",
    'const notLiteral = require(name);',
    'const a1 = process.env.MICHI_A;',
    'const a2 = process.env.MICHI_A;',
    "const b1 = process.env['MICHI_B'];",
    "const key = 'K';",
    'const dynamicEnv = process.env[key];',
    'const copy = { ...process.env };',
    'const child = { env: process.env };',
    "if (name === 'kiro') { void 0; }",
  ].join('\n'),
  'runtime/src/adapters/crew/crewThing.ts': 'export const thing = 1;\n',
  // Test files are never candidates and never counted for runtime ids.
  'runtime/src/adapters/crew/CrewAdapter.test.ts': [
    "import { x } from '../../../../backend/src/services/fromTest';",
    'const fromTest = process.env.FROM_TEST;',
    "if (x === 'kiro') { void fromTest; }",
  ].join('\n'),
  // Generated protocol files are excluded from the candidate set.
  'runtime/src/adapters/codex/gen/v2.ts': [
    "import { y } from '../../../../../backend/src/services/fromGen';",
    'export const gen = process.env.FROM_GEN ?? y;',
  ].join('\n'),
  // Not a candidate: its imports/env are app concerns; runtime-id literals count.
  'backend/src/agents/chatHub.ts': [
    "import { db } from '../services/dbRepository';",
    'const fromHub = process.env.NOT_CANDIDATE;',
    'export function pick(runtime: string) {',
    "  if (runtime === 'kiro') return 1;",
    "  if ('kiro' == runtime) return 2;",
    "  if (runtime !== 'codex') return 3;",
    "  if (runtime != 'pi') return 4;",
    "  if (runtime === 'kiroish') return 5;",
    "  if (runtime === 'other') return 6;",
    "  if (runtime < 'kiro') return 7;",
    "  const label = 'crew';",
    '  const flag = runtime === `claude`;',
    '  switch (runtime) {',
    "    case 'kiro': return 8;",
    "    case 'crew': return 9;",
    "    case 'other': return 10;",
    '  }',
    '  return flag && label && db && fromHub ? 11 : 12;',
    '}',
  ].join('\n'),
  'backend/src/agents/sessionRegistry.ts': 'export const registry = 1;\n',
  'backend/src/agents/runs/runMcpSlot/index.ts': [
    "import { hub } from '../../chatHub';",
    "import { thing } from '../../../../../runtime/src/adapters/crew/crewThing';",
    "export const isCodex = (x: string) => x === 'codex' && hub && thing;",
  ].join('\n'),
  'backend/src/agents/runs/other.ts': [
    "import { db } from '../../services/dbRepository';",
    'export const other = process.env.OTHER ?? db;',
  ].join('\n'),
  // Adapter directory: candidate, but runtime-id literals are allowed here.
  'runtime/src/adapters/claude/ClaudeSession.ts': [
    "export const isClaude = (kind: string) => kind === 'claude';",
    'export const home = process.env.HOME;',
  ].join('\n'),
  // Pi is neither a candidate nor scanned for runtime ids.
  'backend/src/agents/pi/PiRuntime.ts': [
    "import { db } from '../../services/dbRepository';",
    "export const isPi = (x: string) => x === 'pi' && db;",
    'export const key = process.env.PI_KEY;',
  ].join('\n'),
  'backend/src/agents/workflows/flow.ts': "export const isClaude = (r: string) => r === 'claude';\n",
  'backend/src/routes/agent.ts': [
    "export function route(r: string) {",
    "  if (r === 'codex' || r === 'crew') return 1;",
    '  switch (r) {',
    "    case 'codex': return 2;",
    '  }',
    '  return 0;',
    '}',
  ].join('\n'),
  'backend/src/routes/agent.test.ts': "export const t = (r: string) => r === 'kiro';\n",
  'backend/src/services/chatEvents/index.ts': [
    "import { cfg } from '../agentConfig';",
    "import { registry } from '../../agents/sessionRegistry';",
    'export const events = cfg && registry;',
  ].join('\n'),
  'backend/src/services/agentConfig.ts': 'export const cfg = 1;\n',
  'backend/src/services/appTypes.ts': 'export type AppType = number;\n',
  'backend/src/services/reexport.tsx': 'export const r = 1;\n',
  'backend/src/services/dbRepository.ts': 'export const a = 1; export const b = 2; export const db = 3;\n',
  'backend/src/services/dbTypes.ts': 'export type T = number;\n',
  'backend/src/services/sideEffect.js': 'module.exports = {};\n',
  'backend/src/services/legacy.cjs': 'module.exports = {};\n',
  'backend/src/services/lazy.mjs': 'export default {};\n',
  'backend/src/services/data.json': '{}\n',
  'backend/src/services/settings.json': '{}\n',
  'backend/src/services/dyn/index.ts': 'export const dyn = 1;\n',
  'backend/src/services/typeOnly.ts': 'export const typeOnly = 1;\n',
  'backend/src/services/esmStyle.ts': 'export const esm = 1;\n',
  'backend/src/services/both.ts': 'export const both = 1;\n',
  'backend/src/services/both.js': 'module.exports = {};\n',
  'backend/src/services/fromTest.ts': 'export const x = 1;\n',
  'backend/src/services/fromGen.ts': 'export const y = 1;\n',
  'shared/src/index.ts': 'export const root = 1;\n',
  // Reserved runtime package: its imports into backend/ always count.
  'runtime/src/index.ts': [
    "import { inner } from './inner';",
    "import type { AgentRuntime } from '../../backend/src/agents/registry';",
    "import { db } from '../../backend/src/services/dbRepository';",
    "import { z } from 'zod';",
    'export const level = process.env.RUNTIME_LEVEL ?? inner;',
  ].join('\n'),
  'runtime/src/inner.ts': "export const inner = (x: string) => x === 'kiro';\n",
  // Package adapter directory: candidate, but runtime-id literals are allowed here.
  'runtime/src/adapters/codex/CodexRuntime.ts': "export const isCodex = (x: string) => x === 'codex';\n",
  // The shared ACP core is no runtime's adapter: its runtime-id literals count.
  'runtime/src/adapters/acp/client.ts': "export const isKiro = (x: string) => x === 'kiro';\n",
};

const ADAPTER = 'runtime/src/adapters/crew/CrewAdapter.ts';

describe('runtime boundary scanner', () => {
  let root: string;

  before(() => {
    root = tempRepo('michi-runtime-boundary-');
    writeTree(root, MINI_REPO);
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('records import edges from candidates into non-candidate repo modules', () => {
    assert.deepEqual(boundary.scan(root).imports, [
      'backend/src/agents/registry.ts\tbackend/src/services/appTypes.ts',
      'backend/src/agents/registry.ts\tbackend/src/services/reexport.tsx',
      'backend/src/agents/runs/runMcpSlot/index.ts\tbackend/src/agents/chatHub.ts',
      'backend/src/services/chatEvents/index.ts\tbackend/src/services/agentConfig.ts',
      `${ADAPTER}\tbackend/src/agents/chatHub.ts`,
      `${ADAPTER}\tbackend/src/agents/sessionRegistry.ts`,
      `${ADAPTER}\tbackend/src/services/both.ts`,
      `${ADAPTER}\tbackend/src/services/data.json`,
      `${ADAPTER}\tbackend/src/services/dbRepository.ts`,
      `${ADAPTER}\tbackend/src/services/dbTypes.ts`,
      `${ADAPTER}\tbackend/src/services/dyn/index.ts`,
      `${ADAPTER}\tbackend/src/services/esmStyle.ts`,
      `${ADAPTER}\tbackend/src/services/lazy.mjs`,
      `${ADAPTER}\tbackend/src/services/legacy.cjs`,
      `${ADAPTER}\tbackend/src/services/missing`,
      `${ADAPTER}\tbackend/src/services/settings.json`,
      `${ADAPTER}\tbackend/src/services/sideEffect.js`,
      `${ADAPTER}\tbackend/src/services/typeOnly.ts`,
      `${ADAPTER}\truntime/src/adapters/codex/gen/v2.ts`,
      `${ADAPTER}\tshared/src/index.ts`,
      'runtime/src/index.ts\tbackend/src/agents/registry.ts',
      'runtime/src/index.ts\tbackend/src/services/dbRepository.ts',
    ]);
  });

  test('records named, bracketed and bare process.env reads in candidates only', () => {
    assert.deepEqual(boundary.scan(root).env, [
      'runtime/src/adapters/claude/ClaudeSession.ts\tHOME',
      `${ADAPTER}\t*`,
      `${ADAPTER}\tMICHI_A`,
      `${ADAPTER}\tMICHI_B`,
      'runtime/src/index.ts\tRUNTIME_LEVEL',
    ]);
  });

  test('counts runtime-id comparisons and case labels outside adapter directories', () => {
    assert.deepEqual(boundary.scan(root).runtimeIds, [
      'backend/src/agents/chatHub.ts\tclaude\t1',
      'backend/src/agents/chatHub.ts\tcodex\t1',
      'backend/src/agents/chatHub.ts\tcrew\t1',
      'backend/src/agents/chatHub.ts\tkiro\t3',
      'backend/src/agents/chatHub.ts\tpi\t1',
      'backend/src/agents/runs/runMcpSlot/index.ts\tcodex\t1',
      'backend/src/agents/workflows/flow.ts\tclaude\t1',
      'backend/src/routes/agent.ts\tcodex\t2',
      'backend/src/routes/agent.ts\tcrew\t1',
      'runtime/src/adapters/acp/client.ts\tkiro\t1',
      'runtime/src/inner.ts\tkiro\t1',
    ]);
  });

  test('runtime-id globs exempt each runtime\'s adapter directory by name, not the shared ACP core', () => {
    assert.ok(boundary.RUNTIME_ID_GLOBS.includes('!runtime/src/adapters/{claude,codex,crew,kiro,antigravity}/**'));
    assert.ok(!boundary.RUNTIME_ID_GLOBS.includes('!runtime/src/adapters/**'));
  });

  test('counts antigravity comparisons outside its own adapter directory', () => {
    const repo = tempRepo('michi-runtime-boundary-antigravity-');
    try {
      writeTree(repo, {
        'backend/src/routes/agent.ts': "export const a = (r: string) => r === 'antigravity';\n",
        'runtime/src/adapters/antigravity/antigravityFlavor.ts': "export const a = (r: string) => r === 'antigravity';\n",
      });
      assert.deepEqual(boundary.scan(repo).runtimeIds, ['backend/src/routes/agent.ts\tantigravity\t1']);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('candidate globs cover the runtime layer and reserve runtime/src', () => {
    assert.ok(boundary.CANDIDATE_GLOBS.includes('runtime/src/**/*.ts'));
    assert.ok(boundary.CANDIDATE_GLOBS.includes('!runtime/src/adapters/codex/gen/**'));
  });

  test('skips the runtime package when runtime/ does not exist', () => {
    const bare = tempRepo('michi-runtime-boundary-bare-');
    try {
      writeTree(bare, {
        'backend/src/agents/registry.ts': "import { x } from '../services/appThing';\nexport const y = x;\n",
        'backend/src/services/appThing.ts': 'export const x = 1;\n',
      });
      assert.deepEqual(boundary.scan(bare), {
        imports: ['backend/src/agents/registry.ts\tbackend/src/services/appThing.ts'],
        env: [],
        runtimeIds: [],
      });
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  test('scans a git ref instead of the working tree', () => {
    const repo = tempRepo('michi-runtime-boundary-git-');
    const git = (...args: string[]) => execFileSync(GIT, ['-C', repo, '-c', 'core.hooksPath=/dev/null', ...args], { stdio: 'pipe' });
    try {
      writeTree(repo, {
        'backend/src/agents/registry.ts': "import { x } from '../services/committed';\nexport const y = x;\n",
        'backend/src/services/committed.ts': 'export const x = 1;\n',
        'backend/src/routes/agent.ts': "export const k = (r: string) => r === 'kiro';\n",
      });
      git('init', '-q');
      git('add', '-A');
      git('-c', 'user.name=Boundary Test', '-c', 'user.email=boundary@example.com', '-c', 'commit.gpgsign=false',
        'commit', '-q', '--no-verify', '-m', 'base');
      writeTree(repo, {
        'backend/src/agents/registry.ts': "import { x } from '../services/worktreeOnly';\nexport const y = process.env.WORKTREE ?? x;\n",
        'backend/src/services/worktreeOnly.ts': 'export const x = 1;\n',
        'runtime/src/index.ts': "import { x } from '../../backend/src/services/committed';\nexport const z = x;\n",
      });

      assert.deepEqual(boundary.scan(repo, { ref: 'HEAD' }), {
        imports: ['backend/src/agents/registry.ts\tbackend/src/services/committed.ts'],
        env: [],
        runtimeIds: ['backend/src/routes/agent.ts\tkiro\t1'],
      });
      assert.deepEqual(boundary.scan(repo).imports, [
        'backend/src/agents/registry.ts\tbackend/src/services/worktreeOnly.ts',
        'runtime/src/index.ts\tbackend/src/services/committed.ts',
      ]);
      assert.throws(() => boundary.scan(repo, { ref: '--output=/tmp/x' }), /invalid git ref/i);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('runtime boundary fixtures', () => {
  test('loadFixture merges baseline and pending files, skipping comments and blank lines', () => {
    const dir = tempRepo('michi-runtime-boundary-fixture-');
    try {
      writeTree(dir, {
        'imports.txt': '# baseline\n\nb.ts\tapp/z.ts\na.ts\tapp/y.ts\r\n',
        'imports.pending.txt': '# pending: feature @ abc123\na.ts\tapp/x.ts\nb.ts\tapp/z.ts\n',
        'env.txt': 'a.ts\tHOME\n',
        'runtime-ids.txt': 'a.ts\tkiro\t2\nc.ts\tpi\t1\n',
        'runtime-ids.pending.txt': '# pending: feature @ abc123\na.ts\tkiro\t4\nb.ts\tcodex\t1\n',
      });
      assert.deepEqual(boundary.loadFixture(dir), {
        imports: ['a.ts\tapp/x.ts', 'a.ts\tapp/y.ts', 'b.ts\tapp/z.ts'],
        env: ['a.ts\tHOME'],
        runtimeIds: ['a.ts\tkiro\t4', 'b.ts\tcodex\t1', 'c.ts\tpi\t1'],
      });
      assert.deepEqual(boundary.loadFixture(dir, { pending: false }), {
        imports: ['a.ts\tapp/y.ts', 'b.ts\tapp/z.ts'],
        env: ['a.ts\tHOME'],
        runtimeIds: ['a.ts\tkiro\t2', 'c.ts\tpi\t1'],
      });
      assert.deepEqual(boundary.loadFixture(dir, { baseline: false }), {
        imports: ['a.ts\tapp/x.ts', 'b.ts\tapp/z.ts'],
        env: [],
        runtimeIds: ['a.ts\tkiro\t4', 'b.ts\tcodex\t1'],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loadFixture rejects malformed lines instead of silently ignoring them', () => {
    const dir = tempRepo('michi-runtime-boundary-bad-');
    try {
      writeTree(dir, { 'runtime-ids.txt': 'a.ts\tkiro\n' });
      assert.throws(() => boundary.loadFixture(dir), /runtime-ids\.txt:1/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('compare fails only on additions and count increases; reports stale entries separately', () => {
    const fixture = {
      imports: ['a.ts\tapp/old.ts', 'a.ts\tapp/kept.ts'],
      env: ['a.ts\tHOME'],
      runtimeIds: ['a.ts\tkiro\t2', 'b.ts\tcodex\t3', 'c.ts\tpi\t1', 'd.ts\tcrew\t1'],
    };
    const current = {
      imports: ['a.ts\tapp/kept.ts', 'a.ts\tapp/new.ts'],
      env: ['a.ts\tHOME'],
      runtimeIds: ['a.ts\tkiro\t3', 'b.ts\tcodex\t1', 'd.ts\tcrew\t1', 'e.ts\tclaude\t1'],
    };
    assert.deepEqual(boundary.compare(current, fixture), {
      added: { imports: ['a.ts\tapp/new.ts'], env: [], runtimeIds: ['a.ts\tkiro\t3', 'e.ts\tclaude\t1'] },
      stale: { imports: ['a.ts\tapp/old.ts'], env: [], runtimeIds: ['b.ts\tcodex\t3', 'c.ts\tpi\t1'] },
      hasAdded: true,
    });
    assert.equal(boundary.compare(fixture, fixture).hasAdded, false);
  });
});

describe('runtime boundary ratchet', () => {
  let comparison: Comparison;
  // Pending entries belong to unmerged branches, so only baseline entries can be stale.
  let baselineStale: Entries;

  before(() => {
    const current = boundary.scan(REPO_ROOT);
    comparison = boundary.compare(current, boundary.loadFixture(FIXTURE_DIR));
    baselineStale = boundary.compare(current, boundary.loadFixture(FIXTURE_DIR, { pending: false })).stale;
  });

  for (const kind of boundary.KINDS) {
    test(`no new ${kind.label}`, () => {
      const stale = baselineStale[kind.key];
      if (stale.length > 0) {
        console.log(`[runtime boundary] ${stale.length} stale ${kind.file}.txt entr${stale.length === 1 ? 'y' : 'ies'} `
          + `(run \`node backend/scripts/runtimeBoundary.cjs --write\` to drop them):\n${stale.join('\n')}`);
      }
      const added = comparison.added[kind.key];
      assert.deepEqual(added, [], `New runtime boundary ${kind.label} (${kind.file}):\n${added.join('\n')}\n\n${boundary.REMEDIATION}`);
    });
  }
});
