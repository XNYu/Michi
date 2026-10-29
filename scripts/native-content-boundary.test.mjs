import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Michi's mirror of Agent Desk's block code (see its README.md): native content, kept under Desk's own paths.
const vendorBlocks = join(root, 'frontend/src/components/terminal/content/page/vendor-blocks');

function productionSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['dist', 'gen', 'migrations', 'node_modules'].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

// Blanks comments and keeps strings, so a comment that names an endpoint is not a dependency on it.
function stripComments(source) {
  let out = '';
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = (end === -1 ? source.length : end) - 1;
      out += ' ';
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 1;
      out += ' ';
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c && (c === '`' || source[j] !== '\n')) j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j;
    } else if (c === '\\') {
      out += source.slice(i, i + 2);
      i += 1;
    } else {
      out += c;
    }
  }
  return out;
}

const forbiddenText = /\/api\/desk\b|\bMICHI_DESK(?:_\w+)?\b|\bAGENT_DESK_\w+\b|127\.0\.0\.1:4317|desk:\/\//;
const importSpecifier = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;
// The removed Desk modules: desk/ directories, desk.ts, deskDatabases.ts, DeskToolReceipts.tsx and the like.
const deskModule = /(?:^|\/)(?:desk(?:\/|\.|$)|desk[A-Z]|Desk[A-Z])/;

function boundaryViolations(path, source) {
  const code = stripComments(source);
  const found = [];
  const text = forbiddenText.exec(code);
  if (text) found.push(text[0]);
  for (const [, , specifier] of code.matchAll(importSpecifier)) {
    if (specifier.startsWith('.')) {
      const target = resolve(dirname(path), specifier);
      if (target.startsWith(vendorBlocks + sep)) continue;
      if (deskModule.test(relative(root, target).split(sep).join('/'))) found.push(specifier);
    } else if (deskModule.test(specifier)) {
      found.push(specifier);
    }
  }
  return found;
}

test('native content has no external Desk endpoint, credentials, protocol or module dependency', () => {
  const violations = ['frontend/src', 'backend/src', 'shared/src', 'electron']
    .flatMap(directory => productionSources(join(root, directory)))
    .flatMap(path => boundaryViolations(path, readFileSync(path, 'utf8')).map(match => `${relative(root, path)}: ${match}`));
  assert.deepEqual(violations, []);
});

test('the boundary allows the vendored block mirror and still rejects the external Desk', () => {
  const page = join(root, 'frontend/src/components/terminal/content/page/Page.tsx');
  const mirrored = join(vendorBlocks, 'src/desk/blocks/catalog/data/StatBlock.tsx');
  assert.deepEqual(boundaryViolations(page, "import { ChartBlock } from './vendor-blocks/src/desk/blocks/catalog/chart/ChartBlock';"), []);
  assert.deepEqual(boundaryViolations(mirrored, "import type {DeskThread} from '../../../../../shared/desk';"), []);
  assert.deepEqual(boundaryViolations(mirrored, '/** What GET /api/desk/databases/:id answers. */\nconst x = 1; // desk://x'), []);
  assert.deepEqual(boundaryViolations(mirrored, "const r = await fetch('/api/desk/databases/' + id);"), ['/api/desk']);
  assert.deepEqual(boundaryViolations(mirrored, 'const url = `desk://thread/${id}`;'), ['desk://']);
  assert.deepEqual(boundaryViolations(page, 'const token = process.env.AGENT_DESK_TOKEN;'), ['AGENT_DESK_TOKEN']);
  assert.deepEqual(boundaryViolations(page, "const base = 'http://127.0.0.1:4317';"), ['127.0.0.1:4317']);
  assert.deepEqual(boundaryViolations(page, "import { useDesk } from '../../../../state/desk/DeskProvider';"), ['../../../../state/desk/DeskProvider']);
  assert.deepEqual(boundaryViolations(page, "import { api } from '../../../../services/api/deskDatabases';"), ['../../../../services/api/deskDatabases']);
  assert.deepEqual(boundaryViolations(page, "const m = await import('../../desk/page/DeskDocument');"), ['../../desk/page/DeskDocument']);
  assert.deepEqual(boundaryViolations(mirrored, "import { client } from '../../../../../../../../../../state/desk/deskOrigins';"), ['../../../../../../../../../../state/desk/deskOrigins']);
});
