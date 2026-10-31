import React, { Component, memo, useId, useRef, useState } from 'react';
import type { MichiPageBlock } from 'michi-shared';
import { Plus } from 'lucide-react';
import { MichiMenu, type MichiMenuEntry } from './MichiMenu';
import type { BlockProps, BlockRenderer, MichiBlockCtx } from './blockTypes';
import { blocksOf, clipWords, list, looseTitle, objects, str, typeLabel } from './michiPageModel';
import {
  CalloutBlock,
  CodeBlock,
  DividerBlock,
  HeadingBlock,
  KeyValueBlock,
  LinkBlock,
  MarkdownBlock,
  QuoteBlock,
  StatusBlock,
  TagsBlock,
  TextBlock,
} from './blocks/text';
import {
  ChecklistBlock,
  ChoiceBlock,
  CompareBlock,
  ConflictBlock,
  MetricsBlock,
  NextStepsBlock,
  PlanActualBlock,
  ProgressBlock,
  ProsConsBlock,
  StatBlock,
} from './blocks/data';
import { CriteriaBlock, DatabaseBlock, TableBlock } from './blocks/tables';
import { DatabaseRefBlock } from './blocks/databaseRef';
import { TaskViewBlock } from './blocks/taskView';
import { MilestonesBlock, TimelineBlock } from './blocks/time';
import { ForgotBlock, ThreadsBlock } from './blocks/threads';
import { CustomBlock } from './blocks/custom';
import { richRenderers } from './richRenderers';
import { useReveal } from './vendor-blocks/src/desk/blocks/catalog/text/outline';
import type { PageBlockWithSources } from './vendor-blocks/shared/desk-blocks';
import './michiPage.css';
import { toggledChecklist } from './pageEdits';
import { ResponsiveGrid } from './blocks/Grid';
import { PageViewEntry } from './PageViewContext';

/** Michi nests blocks at most two levels deep; anything deeper is not drawn. */
const MAX_DEPTH = 2;

/** A container's section holds at most this many blocks (the page model's limit). */
const SLOT_MAX = 20;

/** The "+" at the foot of a container's section: what the page offers to put there. */
function SlotAdd({ entries, label }: { entries: MichiMenuEntry[]; label: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <div className="michi-doc-slot__add" data-block-chrome="">
      <button
        type="button"
        className="michi-doc-slot__add-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={(event) => {
          const el = event.currentTarget;
          setAnchor((open) => (open ? null : el));
        }}
      >
        <Plus size={13} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {anchor && (
        <MichiMenu
          anchor={anchor}
          label={label}
          entries={entries}
          onClose={(restore) => {
            setAnchor(null);
            if (restore) anchor.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
}

/** One line saying what a block is, for types Michi does not draw. */
export function UnknownBlock({ block }: { block: MichiPageBlock }) {
  const loose = looseTitle(block);
  const kind = typeLabel(typeof block.type === 'string' ? block.type : '');
  return (
    <p className="michi-doc-unknown" data-michi-block="unknown" data-type={block.type}>
      {loose ? `${kind} · ${clipWords(loose, 80)}` : kind}
    </p>
  );
}

/** A block whose drawing throws shows its one-line label; the rest of the page goes on. */
class BlockBoundary extends Component<{ block: MichiPageBlock; children: React.ReactNode }, { block: MichiPageBlock; failed: boolean }> {
  state = { block: this.props.block, failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: { block: MichiPageBlock }, state: { block: MichiPageBlock; failed: boolean }) {
    return props.block === state.block ? null : { block: props.block, failed: false };
  }

  render() {
    return this.state.failed ? <UnknownBlock block={this.props.block} /> : this.props.children;
  }
}

function Slot({ blocks, ctx, owner, replace, name }: { blocks: MichiPageBlock[]; ctx: MichiBlockCtx; owner: MichiPageBlock; replace: (blocks: MichiPageBlock[]) => MichiPageBlock; name?: string }) {
  // The "+" can fire after an await (the host may open a database first); it must build from the section's content then, not at render time.
  const latest = useRef({ ctx, owner, blocks, replace });
  latest.current = { ctx, owner, blocks, replace };
  const child: MichiBlockCtx = { ...ctx, depth: ctx.depth + 1,
    updateBlock: ctx.updateBlock ? (block, next) => ctx.updateBlock!(owner, replace(blocks.map((item) => (block.id ? item.id === block.id : item === block) ? next : item))) : undefined,
    toggleItem: ctx.updateBlock ? (block, index) => { const next = toggledChecklist(block, index); if (next) ctx.updateBlock!(owner, replace(blocks.map((item) => (block.id ? item.id === block.id : item === block) ? next : item))); } : undefined,
    requestAssistant: ctx.requestAssistant ? (_block, prompt, title, send) => ctx.requestAssistant!(owner, prompt, title, send) : undefined,
    // The assistant targets top-level blocks only; an item inside a section has no block of its own to name.
    askItem: undefined,
  };
  const { frame } = child;
  const adds = ctx.updateBlock && ctx.slotAddEntries && child.depth <= MAX_DEPTH && blocks.length < SLOT_MAX
    ? ctx.slotAddEntries((block) => {
      const now = latest.current;
      if (!now.ctx.updateBlock || now.blocks.length >= SLOT_MAX) return;
      now.ctx.updateBlock(now.owner, now.replace([...now.blocks, block]));
    })
    : [];
  return (
    <div className="michi-doc-slot">
      {blocks.map((b, i) => (
        <div key={str(b.id) || i} data-block-id={str(b.id) || undefined}>
          {frame && child.depth <= MAX_DEPTH ? frame(b, child) : <MichiBlockView block={b} ctx={child} />}
        </div>
      ))}
      {adds.length > 0 && <SlotAdd entries={adds} label={name?.trim() ? `Add to ${name.trim()}` : 'Add to this section'} />}
    </div>
  );
}

function ColumnsBlock({ block, ctx }: BlockProps) {
  const columns = list(block.columns).map(blocksOf);
  return (
    <div className="michi-doc-columns" data-michi-block="columns" style={{ '--cols': Math.max(1, Math.min(4, columns.length)) } as React.CSSProperties}>
      {columns.map((slot, i) => <Slot key={i} name={`column ${i + 1}`} blocks={slot} ctx={ctx} owner={block} replace={(next) => ({ ...block, columns: columns.map((column, at) => at === i ? next : column) })} />)}
    </div>
  );
}

function GridBlock({ block, ctx }: BlockProps) {
  return <ResponsiveGrid block={block} ctx={ctx} renderRegion={(region, replace) => <Slot name={typeof region.title === 'string' ? region.title : undefined} blocks={region.blocks} ctx={ctx} owner={block} replace={replace} />} />;
}

function TabsBlock({ block, ctx }: BlockProps) {
  const tabs = objects(block.tabs).map((t, i) => ({ label: str(t.label).trim() || `Tab ${i + 1}`, blocks: blocksOf(t.blocks) }));
  const [shown, setShown] = useState(0);
  const baseId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = Math.min(shown, Math.max(0, tabs.length - 1));
  useReveal(tabs.map((t) => t.blocks as PageBlockWithSources[]), setShown);
  if (!tabs.length) return null;
  // Arrows, Home and End move between tabs; only the shown tab is a Tab stop.
  const onKeyDown = (event: React.KeyboardEvent) => {
    const last = tabs.length - 1;
    const next = event.key === 'ArrowRight' ? (current + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (current + last) % tabs.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : null;
    if (next === null) return;
    event.preventDefault();
    setShown(next);
    tabRefs.current[next]?.focus();
  };
  return (
    <div data-michi-block="tabs">
      <div className="michi-doc-tabs__list" role="tablist" onKeyDown={onKeyDown}>
        {tabs.map((t, i) => (
          <button
            key={i}
            ref={(el) => { tabRefs.current[i] = el; }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${i}`}
            aria-selected={i === current}
            aria-controls={`${baseId}-panel`}
            tabIndex={i === current ? 0 : -1}
            className="michi-doc-tabs__tab"
            onClick={() => setShown(i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${current}`}>
        <Slot key={current} name={tabs[current].label} blocks={tabs[current].blocks} ctx={ctx} owner={block} replace={(next) => ({ ...block, tabs: tabs.map((tab, at) => at === current ? { ...tab, blocks: next } : tab) })} />
      </div>
    </div>
  );
}

/** Details start collapsed; the native summary provides keyboard and pointer toggling. */
function ToggleBlock({ block, ctx }: BlockProps) {
  return (
    <details className="michi-doc-toggle" data-michi-block="toggle">
      <summary>{str(block.title).trim() || 'Details'}</summary>
      <Slot name={str(block.title).trim() || undefined} blocks={blocksOf(block.blocks)} ctx={ctx} owner={block} replace={(next) => ({ ...block, blocks: next })} />
    </details>
  );
}

const RENDERERS = new Map<string, BlockRenderer>([
  ['markdown', MarkdownBlock],
  ['heading', HeadingBlock],
  ['text', TextBlock],
  ['callout', CalloutBlock],
  ['quote', QuoteBlock],
  ['divider', DividerBlock],
  ['keyvalue', KeyValueBlock],
  ['tags', TagsBlock],
  ['status', StatusBlock],
  ['code', CodeBlock],
  ['link', LinkBlock],
  ['stat', StatBlock],
  ['metrics', MetricsBlock],
  ['progress', ProgressBlock],
  ['plan-actual', PlanActualBlock],
  ['compare', CompareBlock],
  ['choice', ChoiceBlock],
  ['pros-cons', ProsConsBlock],
  ['checklist', ChecklistBlock],
  ['next-steps', NextStepsBlock],
  ['table', TableBlock],
  ['database', DatabaseBlock],
  ['database-ref', DatabaseRefBlock],
  ['task-view', TaskViewBlock],
  ['milestones', MilestonesBlock],
  ['timeline', TimelineBlock],
  ['threads', ThreadsBlock],
  ['columns', ColumnsBlock],
  ['grid', GridBlock],
  ['tabs', TabsBlock],
  ['toggle', ToggleBlock],
  ['custom', CustomBlock],
  ['conflict', ConflictBlock],
  ['criteria', CriteriaBlock],

  ['forgot', ForgotBlock],
]);

for (const [type, render] of richRenderers(UnknownBlock)) RENDERERS.set(type, render);

/** The renderer for a block type, or undefined when Michi shows it as one line. */
export function rendererFor(type: string): BlockRenderer | undefined {
  return RENDERERS.get(type);
}

function BlockContent({ block, ctx }: BlockProps) {
  if (block.type === 'view-link') return <PageViewEntry action={block.action}>{str(block.label)}</PageViewEntry>;
  if (block.type === 'view') return null;
  if (block.type === 'markdown' && ctx.renderNativeMarkdown) return <>{ctx.renderNativeMarkdown(block)}</>;
  if (block.type === 'page-link' && ctx.renderNativePageLink) return <>{ctx.renderNativePageLink(block)}</>;
  if (block.type === 'database-ref' && ctx.renderNativeDatabaseRef) return <>{ctx.renderNativeDatabaseRef(block)}</>;
  const Renderer = typeof block.type === 'string' ? RENDERERS.get(block.type) : undefined;
  if (!Renderer || ctx.depth > MAX_DEPTH) return <UnknownBlock block={block} />;
  return (
    <BlockBoundary block={block}>
      <Renderer block={block} ctx={ctx} />
    </BlockBoundary>
  );
}

function MichiBlockView(props: BlockProps) {
  const interaction = props.block.interaction as { label?: string; action?: unknown } | undefined;
  return <><BlockContent {...props} />{interaction && <div className="page-view-block-entry"><PageViewEntry action={interaction.action}>{interaction.label}</PageViewEntry></div>}</>;
}

/** One page block, drawn by its type's renderer; unknown, too deep or broken blocks show a one-line label. */
export const MichiBlock = memo(MichiBlockView);
