/** Development-only comparison surface. It uses the same native document and catalog as Pages. */
import { useLayoutEffect, useMemo, useState } from 'react';
import { PAGE_BLOCK_CATALOG, PAGE_BLOCK_TYPES, applyPageOps, type PageBlock, type PageDto } from 'michi-shared';
import { cssVarsFor, DARK_PALETTES, PALETTES } from '../../tokens';
import type { TerminalPalette } from '../../../../state/prefs';
import { NativePageDocument } from '../../spaces/NativePageDocument';
import { MichiMantine } from './mantine/MichiMantine';
import { CHART_KINDS } from './vendor-blocks/shared/desk-catalog';
import { chartSample } from './vendor-blocks/src/desk/component-samples';
import '../../spaces/spaces.css';

export default function NativeBlocksSpecimen() {
  const params = new URLSearchParams(window.location.search);
  const asked = params.get('palette') as TerminalPalette;
  const palette = asked && Object.hasOwn(PALETTES, asked) ? asked : 'bone';
  const vars = useMemo(() => cssVarsFor(palette, PALETTES[palette].accent), [palette]);
  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-terminal-palette', palette);
    for (const [key, value] of Object.entries(vars)) document.documentElement.style.setProperty(key, value);
  }, [palette, vars]);
  const [page, setPage] = useState<PageDto>(() => {
    const only = params.get('only')?.split(',');
    const blocks = PAGE_BLOCK_TYPES.flatMap((type): PageBlock[] => {
      const sample = PAGE_BLOCK_CATALOG[type].example;
      if (!sample || type === 'threads' || (only && !only.includes(type))) return [];
      if (type === 'chart' && params.get('charts') === 'all') return CHART_KINDS.map((kind) => ({ ...chartSample(kind), id: `chart-${kind}`, rev: 1 } as unknown as PageBlock));
      return [{ ...sample, id: `sample-${type}`, rev: 1 }];
    });
    return { id: 'specimen', workspaceId: 'specimen', title: 'Michi native blocks', blocks, revision: 1, viewVersion: 1 } as PageDto;
  });
  return <main className="michi-doc space-doc" style={{ height: '100vh', overflowY: 'auto', background: 'var(--term-bg)', color: 'var(--term-fg)' }}>
    <article style={{ maxWidth: 880, margin: '40px auto', padding: '0 56px' }}>
      <h1 className="michi-doc-title">Michi native blocks</h1>
      <p className="michi-doc-meta">{palette} · {page.blocks.length} blocks</p>
      <MichiMantine dark={DARK_PALETTES.has(palette)}>
        <NativePageDocument page={page} onOpenPage={() => {}} renderDatabaseRef={() => null} onAskAssistant={() => {}}
          onEdit={async (ops) => {
            const result = applyPageOps(page.blocks, ops, { actor: 'user', revision: page.revision + 1, now: Date.now(), newId: () => crypto.randomUUID() });
            if (result.rejected.length) return 'failed';
            setPage((current) => ({ ...current, blocks: result.blocks, revision: current.revision + 1 }));
            return 'ok';
          }} />
      </MichiMantine>
    </article>
  </main>;
}
