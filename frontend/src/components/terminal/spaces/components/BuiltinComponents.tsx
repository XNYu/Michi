import React, { useMemo, useState } from 'react';
import {
  PAGE_BLOCK_CATALOG,
  PAGE_BLOCK_CATEGORIES,
  PAGE_BLOCK_TYPES,
  parsePageBlockInput,
  type MichiPageBlock,
  type PageBlockInput,
  type PageBlockType,
  type ThreadCardItem,
  type ThreadCardState,
} from 'michi-shared';
import { MichiBlock } from '../../content/page/MichiBlock';
import type { MichiBlockCtx } from '../../content/page/blockTypes';
import { toggledChecklist } from '../../content/page/pageEdits';
import { NativeThreadCards } from '../NativeThreadCards';
import { contentOnly, toMichiBlock } from '../nativeBlockAdapter';
import '../nativeBlocks.css';
import '../../content/page/michiPage.css';

export interface BuiltinComponent {
  type: PageBlockType;
  name: string;
  description: string;
  /** Its category's label. */
  category: string;
  /** The sample the card draws, and what Add puts on the page. */
  block: PageBlockInput;
  /** Its content needs more room than one card. */
  wide: boolean;
  /** Why it cannot be added from here; absent when it can. */
  addedBy?: string;
}

/** Every block a person sees on a page; references to other pages, databases and components are made elsewhere. */
const LISTED = PAGE_BLOCK_CATEGORIES.filter((category) => category.id !== 'references');
const WIDE = new Set<PageBlockType>(['plan-actual', 'compare', 'conflict', 'table', 'criteria', 'chart', 'gallery', 'threads', 'grid']);
const HOUR = 3_600_000;

/** The local calendar day `offset` days from `now`, as YYYY-MM-DD. */
function dayFrom(now: number, offset: number): string {
  const at = new Date(now);
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate() + offset);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

/** A plan in days around today: one phase on time, one late, one under way and one still ahead with its forecast. */
function planSample(now: number): PageBlockInput {
  const d = (offset: number) => dayFrom(now, offset);
  return { type: 'plan-actual', title: 'Plan vs actual', items: [
    { label: 'Plan', planStart: d(-14), planEnd: d(-12), actualStart: d(-14), actualEnd: d(-12) },
    { label: 'Schema', planStart: d(-11), planEnd: d(-7), actualStart: d(-11), actualEnd: d(-5) },
    { label: 'Migration', planStart: d(-6), planEnd: d(1), actualStart: d(-4), forecastEnd: d(3) },
    { label: 'Tests', planStart: d(2), planEnd: d(4), forecastStart: d(4), forecastEnd: d(6) },
  ] };
}

/** The conversations the threads sample names, one in each state a card shows. */
const SAMPLE_THREADS: ReadonlyArray<{ nodeId: string; title: string; summary: string; state: ThreadCardState; ago: number }> = [
  { nodeId: 'sample-schema', title: 'S3 · Schema naming', summary: 'Asked: snake_case or camelCase for the new tables?', state: 'waiting', ago: 2 * HOUR },
  { nodeId: 'sample-migration', title: 'S7 · Migrate the MCP config', summary: 'Failed: the end-to-end run timed out', state: 'stalled', ago: 4 * 24 * HOUR },
  { nodeId: 'sample-tests', title: 'S5 · End-to-end tests', summary: 'Running the last 9 suites.', state: 'running', ago: HOUR / 3 },
  { nodeId: 'sample-docs', title: 'S2 · Update the docs', summary: 'The migration guide is written.', state: 'done', ago: 26 * HOUR },
];

function sampleThreadItems(now: number): ThreadCardItem[] {
  return SAMPLE_THREADS.map((thread) => ({
    nodeId: thread.nodeId, workspaceId: 'sample', title: thread.title, state: thread.state, summary: thread.summary, at: now - thread.ago, messageId: null,
  }));
}

/** The catalog's components, by category, each with the sample its card draws. */
export function builtinComponents(now: number): BuiltinComponent[] {
  return LISTED.flatMap((category) => PAGE_BLOCK_TYPES.flatMap((type): BuiltinComponent[] => {
    const entry = PAGE_BLOCK_CATALOG[type];
    if (entry.category !== category.id || !entry.example) return [];
    return [{
      type,
      name: entry.label,
      description: entry.blurb,
      category: category.label,
      block: type === 'plan-actual' ? planSample(now) : entry.example,
      wide: WIDE.has(type),
      // Thread cards name real conversations, which a sample cannot.
      ...(type === 'threads' ? { addedBy: 'The assistant adds these from the conversations behind a page.' } : {}),
    }];
  }));
}

const CATEGORIES = ['All', ...LISTED.map((category) => category.label)] as const;

/** One card's preview: the real renderer on a sample. Picks, ticks and kept versions change the sample only. */
function Sample({ block, now }: { block: PageBlockInput; now: number }) {
  const [sample, setSample] = useState(block);
  const ctx = useMemo<MichiBlockCtx>(() => {
    const keep = (next: MichiPageBlock) => {
      const parsed = parsePageBlockInput(contentOnly(next));
      if (parsed && parsed.type === block.type) setSample(parsed);
    };
    return {
      depth: 0,
      now,
      loadImages: true,
      updateBlock: (_display, next) => keep(next),
      toggleItem: (display, index) => {
        const next = toggledChecklist(display, index);
        if (next) keep(next);
      },
      renderNativeThreads: (display) => (
        <NativeThreadCards
          block={{ ...(typeof display.title === 'string' ? { title: display.title } : {}), nodeIds: Array.isArray(display.nodeIds) ? display.nodeIds.filter((id): id is string => typeof id === 'string') : [] }}
          items={sampleThreadItems(now)}
          onOpen={() => {}}
          now={now}
        />
      ),
    };
  }, [block.type, now]);
  return <MichiBlock block={toMichiBlock({ ...sample, id: `sample-${block.type}`, rev: 1 })} ctx={ctx} />;
}

/**
 * Every built-in page component, drawn by the renderer pages use. The
 * assistant reaches for these first, and makes a workspace component only
 * when none fits.
 */
export function BuiltinComponents({ onInsert, now: fixedNow }: { onInsert?: (block: PageBlockInput) => Promise<void>; now?: number }) {
  const [openedAt] = useState(() => Date.now());
  const now = fixedNow ?? openedAt;
  const all = useMemo(() => builtinComponents(now), [now]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<typeof CATEGORIES[number]>('All');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const words = query.trim().toLowerCase();
  const items = all.filter((item) => (category === 'All' || item.category === category)
    && `${item.name} ${item.description} ${item.type} ${item.category}`.toLowerCase().includes(words));
  return <section className="component-catalog" aria-label="Built-in components">
    <div className="component-catalog__heading"><h2>Built-in components</h2><span>{all.length}</span></div>
    <p className="component-catalog__description">The building blocks of a page. The assistant uses these first and makes a workspace component only when none fits. Previews use sample content; what you change here stays in the preview.</p>
    <input className="component-catalog__search" type="search" aria-label="Search components" placeholder="Search components, such as a chart or a checklist" value={query} onChange={(event) => setQuery(event.target.value)} />
    <div className="component-catalog__filters" role="group" aria-label="Component categories">{CATEGORIES.map((item) => <button key={item} type="button" aria-pressed={category === item} onClick={() => setCategory(item)}>{item}</button>)}</div>
    {error && <p role="alert">{error}</p>}
    <div className="component-catalog__grid">{items.map((item) => <article className="component-catalog__card" key={item.type} data-wide={item.wide || undefined}>
      <div className="component-catalog__preview spaces-home" data-native-page=""><Sample block={item.block} now={now} /></div>
      <div className="component-catalog__caption"><div><h3>{item.name}</h3><code>{item.type}</code></div><p>{item.description}</p>
        {item.addedBy ? <p className="component-catalog__added-by">{item.addedBy}</p> : onInsert && <button type="button" aria-label={`Add ${item.name} to the page`} disabled={busy !== null} onClick={async () => {
          setBusy(item.type); setError(null);
          try { await onInsert(item.block); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not insert this component.'); }
          finally { setBusy(null); }
        }}>{busy === item.type ? 'Adding…' : 'Add to page'}</button>}
      </div>
    </article>)}</div>
    {!items.length && <p className="component-catalog__description" role="status">No components match. Try another search or category.</p>}
  </section>;
}
