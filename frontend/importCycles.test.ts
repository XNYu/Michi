import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findRuntimeImportCycles } from './scripts/importCycles.mjs';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'src');

// Runtime cycles that predate this check, by member files relative to src/.
// A cycle whose files are not all inside one of these sets fails the test.
// Shrink or remove an entry when its cycle is broken.
const KNOWN_CYCLES: string[][] = [
  [
    'components/terminal/assistant/AssistantLinks.tsx',
    'components/terminal/spaces/NativePageDocument.tsx',
    'components/terminal/spaces/SpacesPage.tsx',
    'components/terminal/spaces/home/HomeDocument.tsx',
    'components/terminal/spaces/home/NativeHomeSection.tsx',
    'components/terminal/spaces/home/SpacesHome.tsx',
    'components/terminal/spaces/home/WorkspaceHome.tsx',
    'components/terminal/spaces/home/homeLinks.ts',
    'components/terminal/spaces/home/useHomeNavigation.ts',
    'components/terminal/spaces/metaChat/MetaChatCards.tsx',
    'components/terminal/spaces/metaChat/PageLinkChip.tsx',
    'components/terminal/spaces/metaChat/SpacesMetaChat.tsx',
    'state/metaChat/spacesPages.ts',
    'state/metaChat/turnContext.ts',
  ],
];

describe('findRuntimeImportCycles', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('follows value and dynamic imports and ignores imports erased as types', () => {
    root = mkdtempSync(join(tmpdir(), 'import-cycles-'));
    const files: Record<string, string> = {
      'a.ts': "import { b } from './b';\nexport const a = () => b;\n",
      'b.ts': "export const b = 1;\nexport const load = () => import('./a');\n",
      'types/c.ts': [
        "import type { D } from './d';",
        "import { type E } from './d';",
        "import { F } from './d';",
        "export type C = D | E | F;",
        "export type { G } from './d';",
        'export const c = 1;',
      ].join('\n'),
      'types/d.ts': "import { c } from './c';\nexport type D = 1; export type E = 2; export type F = 3; export type G = 4;\nexport const d = c;\n",
      'classes/e.ts': "import { Base } from './f';\nexport class E extends Base {}\n",
      'classes/f.ts': "import { E } from './e';\nexport class Base {}\nexport const make = () => new E();\n",
      'jsx/g.tsx': "import { H } from './h';\nexport const G = () => <H />;\n",
      'jsx/h.tsx': "import { G } from './g';\nexport function H() { return null; }\nexport const again = G;\n",
    };
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), text);
    }

    expect(findRuntimeImportCycles(root)).toEqual([
      { files: ['a.ts', 'b.ts'], edges: ['a.ts -> b.ts', 'b.ts -> a.ts'] },
      { files: ['classes/e.ts', 'classes/f.ts'], edges: ['classes/e.ts -> classes/f.ts', 'classes/f.ts -> classes/e.ts'] },
      { files: ['jsx/g.tsx', 'jsx/h.tsx'], edges: ['jsx/g.tsx -> jsx/h.tsx', 'jsx/h.tsx -> jsx/g.tsx'] },
    ]);
  });
});

describe('frontend runtime import graph', () => {
  it('has no runtime import cycle outside the known baseline', () => {
    const cycles = findRuntimeImportCycles(SRC_DIR);
    const known = KNOWN_CYCLES.map((files) => new Set(files));
    const added = cycles.filter((cycle) => !known.some((set) => cycle.files.every((file) => set.has(file))));
    const stale = KNOWN_CYCLES.filter((files) => !cycles.some((cycle) => files.every((file) => cycle.files.includes(file))));
    if (stale.length > 0) {
      console.log(`[import cycles] ${stale.length} KNOWN_CYCLES entr${stale.length === 1 ? 'y is' : 'ies are'} no longer a full cycle; shrink or remove:\n${stale.map((files) => files.join('\n')).join('\n\n')}`);
    }
    // Break a new cycle by moving the shared code or types to a module both sides can import.
    expect(added.map((cycle) => cycle.edges)).toEqual([]);
  }, 30_000);
});
