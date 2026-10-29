import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

interface DependencyRules {
  scan(repoRoot: string): string[];
  loadFixture(file?: string): string[];
  compare(current: string[], fixture: string[]): { added: string[]; stale: string[] };
}

// The scanner is a CommonJS build script (backend/scripts), not part of src/.
const rules = require('../scripts/dependencyRules.cjs') as DependencyRules;

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const MINI_REPO: Record<string, string> = {
  'backend/src/services/db.ts': 'export const getDb = () => 1;\n',
  'backend/src/services/dbRepository.ts': "import { getDb } from './db';\nexport const repo = getDb;\n",
  'backend/src/agents/chatHub.ts': "import { getDb } from '../services/db';\nexport const hub = getDb;\n",
  'backend/src/agents/runs/worker.ts': [
    "import { hub } from '../chatHub';",
    "import type { getDb } from '../../services/db.js';",
    "import { repo } from '../../services/dbRepository';",
    'export const w = [hub, repo];',
  ].join('\n'),
  'backend/src/agents/worker.test.ts': "import { hub } from './chatHub';\nexport const t = hub;\n",
  'backend/src/routes/pages.ts': [
    "import { repo } from '../services/dbRepository';",
    "const lazy = require('../services/db');",
    'export const r = [repo, lazy];',
  ].join('\n'),
  'backend/src/routes/middleware/owner.ts': "export { getDb } from '../../services/db';\n",
  'backend/src/services/other.ts': "import { hub } from '../agents/chatHub';\nimport { getDb } from './db';\nexport const o = [hub, getDb];\n",
  'frontend/src/components/mentions.ts': 'export const m = 1;\n',
  'frontend/src/components/terminal/Pane/index.tsx': 'export const Pane = 1;\n',
  'frontend/src/state/store.tsx': [
    "import { m } from '../components/mentions';",
    "import { Pane } from '../components/terminal/Pane';",
    "import { x } from './local';",
    'export const s = [m, Pane, x];',
  ].join('\n'),
  'frontend/src/state/local.ts': 'export const x = 1;\n',
  'frontend/src/state/store.test.tsx': "import { m } from '../components/mentions';\nexport const t = m;\n",
  'frontend/src/lib/helper.ts': "import { m } from '../components/mentions';\nexport const h = m;\n",
};

describe('layer dependency scanner', () => {
  let root: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-dependency-rules-'));
    for (const [relative, content] of Object.entries(MINI_REPO)) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('records agents -> db/chatHub, routes -> db and state -> components edges only', () => {
    assert.deepEqual(rules.scan(root), [
      'agents-to-chatHub\tbackend/src/agents/runs/worker.ts\tbackend/src/agents/chatHub.ts',
      'agents-to-db\tbackend/src/agents/chatHub.ts\tbackend/src/services/db.ts',
      'agents-to-db\tbackend/src/agents/runs/worker.ts\tbackend/src/services/db.ts',
      'routes-to-db\tbackend/src/routes/middleware/owner.ts\tbackend/src/services/db.ts',
      'routes-to-db\tbackend/src/routes/pages.ts\tbackend/src/services/db.ts',
      'state-to-components\tfrontend/src/state/store.tsx\tfrontend/src/components/mentions.ts',
      'state-to-components\tfrontend/src/state/store.tsx\tfrontend/src/components/terminal/Pane/index.tsx',
    ]);
  });

  test('compare fails only on additions and reports stale entries separately', () => {
    const { added, stale } = rules.compare(['a\tx\ty', 'b\tx\ty'], ['b\tx\ty', 'c\tx\ty']);
    assert.deepEqual(added, ['a\tx\ty']);
    assert.deepEqual(stale, ['c\tx\ty']);
  });

  test('loadFixture rejects malformed lines and unknown rules', () => {
    const file = path.join(root, 'edges.txt');
    fs.writeFileSync(file, '# comment\n\nroutes-to-db\tbackend/src/routes/a.ts\tbackend/src/services/db.ts\n');
    assert.deepEqual(rules.loadFixture(file), ['routes-to-db\tbackend/src/routes/a.ts\tbackend/src/services/db.ts']);
    fs.writeFileSync(file, 'routes-to-everything\ta\tb\n');
    assert.throws(() => rules.loadFixture(file), /edges\.txt:1/);
  });
});

describe('layer dependency ratchet', () => {
  test('no new layer dependency edges', () => {
    const { added } = rules.compare(rules.scan(REPO_ROOT), rules.loadFixture());
    assert.deepEqual(added, [], 'see backend/scripts/dependencyRules.cjs for each rule and how to resolve it');
  });
});
