import React, { useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { pageBlockText, parsePageBlockInput } from 'michi-shared';
import type { ChangeReadScope, PageBlockInput, PageChangeDto, PageDatabaseRow } from 'michi-shared';
import MarkdownContent from '../../MarkdownContent';
import { MICHI_MARKDOWN_FEATURES, InlineMarkdownParagraphs } from '../content/page/blocks/text';
import { joinMarkdown, splitMarkdown } from '../content/page/markdownSegments';
import { SourceTrace, type ExactPageSource } from './SourceTrace';
import './pageChanges.css';

export type AcceptedPageEdit =
  | { kind: 'block'; block: PageBlockInput }
  | { kind: 'row'; values: Record<string, PageDatabaseRow['values'][string]>; body?: string };

export interface ChangeCardProps {
  change: PageChangeDto;
  onAccept: (change: PageChangeDto, edited?: AcceptedPageEdit) => void | Promise<void>;
  onDismiss: (change: PageChangeDto) => void | Promise<void>;
  onReopen: (change: PageChangeDto) => void | Promise<void>;
  onRevert: (change: PageChangeDto) => void | Promise<void>;
  onRedo: (change: PageChangeDto) => void | Promise<void>;
  onOpenSource: (source: ExactPageSource) => void | boolean | Promise<void | boolean>;
  loading?: boolean;
  error?: string | null;
  /** `inline` sits under the changed block; `card` lists it in activity. */
  variant?: 'card' | 'inline';
  /** Name what changed (in lists away from the block itself). */
  showTarget?: boolean;
  /** Keep inline source/actions, with update labels and times collected in the page header. */
  quiet?: boolean;
  /** A readable name for the change's source, e.g. the chat's title. */
  sourceLabel?: (source: PageChangeDto['source']) => string | undefined;
  /**
   * After an undo, where what the block shows now came from: the source of the
   * change before this one, or null when a person wrote it. Left out, the line
   * keeps this change's own source.
   */
  shownSource?: PageChangeDto['source'] | null;
}

export function isPageChangeRevertible(change: PageChangeDto): boolean {
  return change.applicationState === 'applied' && (change.proposalState === null || change.proposalState === 'accepted') && change.source.kind !== 'user';
}

export function isPageChangeRedoable(change: PageChangeDto): boolean {
  return change.applicationState === 'reverted' && (change.proposalState === null || change.proposalState === 'accepted') && change.source.kind !== 'user';
}

function proposedBlock(change: PageChangeDto): PageBlockInput | null {
  if (change.target.kind !== 'block' || change.forward.kind !== 'block' || change.forward.op !== 'upsert') return null;
  const { block } = change.forward;
  const { id: _id, rev: _rev, sources: _sources, edit: _edit, ...content } = block;
  return parsePageBlockInput(content);
}

function proposedRow(change: PageChangeDto) {
  if (change.target.kind !== 'row' || change.forward.kind !== 'row' || change.forward.op !== 'patch') return null;
  const allowed = new Set(change.target.columnIds);
  const values = Object.fromEntries(Object.entries(change.forward.values).filter(([key]) => allowed.has(key)));
  return { values, ...(change.target.body && change.forward.body !== undefined ? { body: change.forward.body } : {}) };
}

function canEditProposal(change: PageChangeDto): boolean {
  if (change.op === 'delete' || change.op === 'move') return false;
  return proposedBlock(change) !== null || proposedRow(change) !== null;
}

function targetName(change: PageChangeDto): string {
  if (change.target.kind === 'block') {
    const snapshot = change.after?.kind === 'block' && change.after.exists ? change.after.block : change.before?.kind === 'block' && change.before.exists ? change.before.block : null;
    if (snapshot?.type === 'heading' && snapshot.text.trim()) return `“${snapshot.text.trim()}”`;
    if (snapshot?.type === 'callout' && snapshot.title?.trim()) return `“${snapshot.title.trim()}”`;
    if ((snapshot?.type === 'markdown' || snapshot?.type === 'callout') && snapshot.text.trim()) {
      const words = snapshot.text.trim().replace(/\s+/g, ' ');
      return `“${words.length > 24 ? `${words.slice(0, 24)}…` : words}”`;
    }
    return 'this block';
  }
  if (change.target.kind === 'row') return 'this row';
  if (change.target.kind === 'database') return 'this database';
  return 'this change';
}

function operationLabel(change: PageChangeDto): string {
  if (change.op === 'delete') return change.target.kind === 'row' ? 'Suggested row deletion' : `Suggested deletion of ${targetName(change)}`;
  if (change.op === 'move') return 'Suggested move';
  if (change.target.kind === 'row') return 'Suggested field update';
  return `Suggested rewrite of ${targetName(change)}`;
}

function previewText(block: PageBlockInput): string {
  switch (block.type) {
    case 'heading': return block.text;
    case 'markdown': return block.text;
    case 'callout': return [block.title, block.text].filter(Boolean).join('\n');
    case 'checklist': return [block.title, ...block.items.map((item) => `${item.done ? '✓' : '○'} ${item.text}`)].filter(Boolean).join('\n');
    case 'metrics': return block.items.map((item) => [item.label, item.value, item.note].filter(Boolean).join(' · ')).join('\n');
    case 'next-steps': return [block.title, ...block.items.map((item) => `${item.who === 'user' ? 'You' : 'Agent'} · ${item.text}${item.unblocks ? ` → ${item.unblocks}` : ''}`)].filter(Boolean).join('\n');
    case 'timeline': return [block.title, ...block.items.map((item) => [item.title, item.detail].filter(Boolean).join(' · '))].filter(Boolean).join('\n');
    case 'database-ref': return 'Database view';
    case 'page-link': return 'Page link';
    case 'component': return `Component · ${block.componentId}${block.pinnedVersion ? ` v${block.pinnedVersion}` : ''}`;
    default: return pageBlockText(block);
  }
}

/** A piece of a block's text a rewrite can change: a Markdown segment, one line of a callout, or one plain line. */
export interface PreviewPiece {
  kind: 'markdown' | 'callout' | 'line';
  text: string;
}

function previewPieces(block: PageBlockInput): PreviewPiece[] {
  if (block.type === 'markdown') return splitMarkdown(block.text).map((segment) => ({ kind: 'markdown', text: segment.text }));
  if (block.type === 'callout') {
    const lines = block.text.split(/\n+/).map((line) => line.trim()).filter(Boolean).map((text): PreviewPiece => ({ kind: 'callout', text }));
    return block.title?.trim() ? [{ kind: 'line', text: block.title.trim() }, ...lines] : lines;
  }
  return previewText(block).split('\n').filter((line) => line.trim()).map((text) => ({ kind: 'line', text }));
}

const samePiece = (a: PreviewPiece, b: PreviewPiece) => a.kind === b.kind && a.text.trim() === b.text.trim();

/**
 * What a rewrite takes out and puts in: the pieces between those both sides
 * share at the start and at the end, so an unchanged heading is not repeated.
 * When the text is the same on both sides (only a tone or a setting changed),
 * the new text is shown whole.
 */
export function changedPieces(before: PageBlockInput | null, after: PageBlockInput): { removed: PreviewPiece[]; added: PreviewPiece[] } {
  const a = before ? previewPieces(before) : [];
  const b = previewPieces(after);
  let start = 0;
  while (start < a.length && start < b.length && samePiece(a[start]!, b[start]!)) start += 1;
  let end = 0;
  while (end < a.length - start && end < b.length - start && samePiece(a[a.length - 1 - end]!, b[b.length - 1 - end]!)) end += 1;
  const removed = a.slice(start, a.length - end);
  const added = b.slice(start, b.length - end);
  return removed.length || added.length ? { removed, added } : { removed: [], added: b };
}

/** Sizes and colours come from the card; Markdown only draws its marks. */
const PIECE_STYLE: React.CSSProperties = { color: 'inherit', fontFamily: 'inherit', fontSize: 'inherit', lineHeight: 'inherit' };

/** Pieces drawn as the page draws them: Markdown formatted, callout lines with their inline marks, plain lines as text. */
function Pieces({ pieces }: { pieces: readonly PreviewPiece[] }) {
  const runs: PreviewPiece[][] = [];
  for (const piece of pieces) {
    const last = runs.at(-1);
    if (last && last[0]!.kind === piece.kind && piece.kind !== 'line') last.push(piece);
    else runs.push([piece]);
  }
  return <>{runs.map((run, index) => {
    if (run[0]!.kind === 'markdown') {
      return <MarkdownContent key={index} text={joinMarkdown(run.map((piece) => piece.text))} size="sm" className="wrap-break-word" style={PIECE_STYLE} features={MICHI_MARKDOWN_FEATURES} />;
    }
    if (run[0]!.kind === 'callout') return <InlineMarkdownParagraphs key={index} text={run.map((piece) => piece.text).join('\n')} />;
    return <p key={index}>{run[0]!.text}</p>;
  })}</>;
}

function relativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return 'just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}

function staleMessage(error: string | null | undefined, change: PageChangeDto): string | null {
  if (!error || !/(409|proposal_stale|stale)/i.test(error)) return null;
  const target = change.target.kind === 'row' ? 'row' : change.target.kind === 'database' ? 'database' : 'block';
  return `This ${target} changed after the suggestion was made. Your draft is still here. Review the current ${target}, then try again or dismiss the suggestion.`;
}

/** Where a change came from: the messages it cites, else what its run read, else the run itself. */
interface ChangeOrigin {
  cited: ExactPageSource[];
  read: ChangeReadScope | null;
  run: ExactPageSource | null;
}

const CITED_SHOWN = 2;

export function changeOrigin(source: PageChangeDto['source']): ChangeOrigin {
  if (source.kind === 'chat' || source.kind === 'helper') return { cited: [source], read: null, run: null };
  if (source.kind !== 'maintenance') return { cited: [], read: null, run: null };
  // Background maintenance cites the conversation message it read; its own run is only the writer.
  const cited = source.evidence.map((entry): ExactPageSource => ({ kind: 'chat', nodeId: entry.nodeId, turnId: entry.turnId, assistantId: entry.messageId ?? entry.assistantId }));
  if (source.read) return { cited, read: source.read, run: null };
  // Before blocks named their sources a first run listed every conversation it read, so none of them is this block's.
  if (cited.length > 1) return { cited: [], read: { kind: 'conversations', count: cited.length }, run: null };
  const run: ExactPageSource = { kind: 'chat', nodeId: source.nodeId, turnId: source.turnId, assistantId: source.assistantId };
  return { cited, read: null, run: cited.length ? null : run };
}

function readLabel(read: ChangeReadScope): string {
  const noun = read.kind === 'conversations' ? 'conversation' : 'workspace home';
  return `${read.count} ${noun}${read.count === 1 ? '' : 's'}`;
}

/** "from “A”", "from “A” and “B”", "from 3 conversations": only conversation titles are quoted. */
function OriginLine({ origin, sourceLabel, onOpenSource, separator = true }: {
  origin: ChangeOrigin;
  sourceLabel?: ChangeCardProps['sourceLabel'];
  onOpenSource: ChangeCardProps['onOpenSource'];
  separator?: boolean;
}) {
  const link = (item: ExactPageSource, fallback: string, key?: string) => {
    const title = sourceLabel?.(item);
    return <button key={key} type="button" className="page-change-link" onClick={() => { void onOpenSource(item); }}>{title ? `“${title}”` : fallback}</button>;
  };
  let body: React.ReactNode = null;
  if (origin.cited.length) {
    // Several messages of one conversation are named once, by its first cited message.
    const cited = origin.cited.filter((item, index, all) => all.findIndex((other) => other.nodeId === item.nodeId) === index);
    const shown = cited.slice(0, cited.length > CITED_SHOWN + 1 ? CITED_SHOWN : CITED_SHOWN + 1);
    const more = cited.length - shown.length;
    body = shown.map((item, index) => <React.Fragment key={`${item.nodeId}:${item.assistantId}`}>
      {index > 0 && (index === shown.length - 1 && !more ? ' and ' : ', ')}
      {link(item, shown.length > 1 ? 'a conversation' : 'the conversation')}
    </React.Fragment>);
    if (more) body = <>{body} and {more} more</>;
  } else if (origin.read && origin.read.count > 0) {
    body = readLabel(origin.read);
  } else if (origin.run) {
    body = link(origin.run, 'the Meta agent');
  }
  if (!body) return null;
  return <>
    {separator && <span aria-hidden="true">·</span>}
    <span>from {body}</span>
  </>;
}

export function ChangeCard({ change, onAccept, onDismiss, onReopen, onRevert, onRedo, onOpenSource, loading = false, error, variant = 'card', sourceLabel, showTarget = false, shownSource, quiet = false }: ChangeCardProps) {
  const [editing, setEditing] = useState(false);
  const [blockDraft, setBlockDraft] = useState(() => {
    const value = proposedBlock(change);
    return value ? JSON.stringify(value, null, 2) : '';
  });
  const [rowValuesDraft, setRowValuesDraft] = useState(() => {
    const value = proposedRow(change);
    return value ? JSON.stringify(value.values, null, 2) : '';
  });
  const [rowBodyDraft, setRowBodyDraft] = useState(() => proposedRow(change)?.body ?? '');
  const [draftError, setDraftError] = useState<string | null>(null);
  const isProposal = change.proposalState === 'pending' || change.proposalState === 'dismissed';
  const stale = staleMessage(error, change);
  const source = change.source;
  const blockValue = useMemo(() => proposedBlock(change), [change]);
  const rowValue = useMemo(() => proposedRow(change), [change]);
  const acceptEdited = () => {
    setDraftError(null);
    if (blockValue) {
      let parsed: unknown;
      try { parsed = JSON.parse(blockDraft); } catch { setDraftError('Enter valid block content.'); return; }
      const block = parsePageBlockInput(parsed);
      if (!block) { setDraftError('Only block content fields can be changed here.'); return; }
      void onAccept(change, { kind: 'block', block });
      return;
    }
    if (rowValue) {
      let parsed: unknown;
      try { parsed = JSON.parse(rowValuesDraft); } catch { setDraftError('Enter valid row field values.'); return; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { setDraftError('Enter row field values as an object.'); return; }
      const values = parsed as Record<string, PageDatabaseRow['values'][string]>;
      const allowed = new Set(change.target.kind === 'row' ? change.target.columnIds : []);
      if (Object.keys(values).some((key) => !allowed.has(key))) { setDraftError('Only fields included in this suggestion can be changed.'); return; }
      void onAccept(change, { kind: 'row', values, ...(change.target.kind === 'row' && change.target.body ? { body: rowBodyDraft } : {}) });
    }
  };

  if (variant === 'inline') {
    const reverted = change.applicationState === 'reverted' && change.proposalState !== 'dismissed';
    // Undoing brings back what was there before, so the line keeps naming where that came from.
    const origin = reverted && shownSource !== undefined
      ? (shownSource ? changeOrigin(shownSource) : null)
      : changeOrigin(source);
    const from = !quiet && origin && <OriginLine origin={origin} sourceLabel={sourceLabel} onOpenSource={onOpenSource} separator />;
    if (change.proposalState === 'pending' && showTarget) {
      return (
        <div className="page-change-line" data-state="pending">
          <Sparkles size={12} strokeWidth={1.7} aria-hidden="true" />
          <span className="page-change-line__lead">Waiting for you: {change.op === 'delete' ? 'remove' : 'rewrite'} {targetName(change)}</span>
          {from}
          <span aria-hidden="true">·</span>
          <button type="button" className="page-change-link" disabled={loading} onClick={() => void onAccept(change)}>Accept</button>
          <button type="button" className="page-change-link" disabled={loading} onClick={() => void onDismiss(change)}>Dismiss</button>
        </div>
      );
    }
    if (change.proposalState === 'pending') {
      const before = change.before?.kind === 'block' && change.before.exists ? parsePageBlockInput((({ id: _i, rev: _r, sources: _s, edit: _e, ...rest }) => rest)(change.before.block)) : null;
      const diff = blockValue ? changedPieces(before, blockValue) : null;
      return (
        <article className="page-change-prop" data-state="pending" aria-label={operationLabel(change)}>
          <header className="page-change-prop__head">
            <Sparkles size={13} strokeWidth={1.7} aria-hidden="true" />
            <strong>{change.op === 'delete' ? 'Suggested removal' : change.op === 'move' ? 'Suggested move' : change.target.kind === 'row' ? 'Suggested field update' : 'Suggested rewrite'}</strong>
            <span>· You edited this, so it asks first</span>
          </header>
          {!editing && diff && (
            <div className="page-change-prop__body">
              {diff.removed.length > 0 && <del className="page-change-prop__old"><Pieces pieces={diff.removed} /></del>}
              {diff.added.length > 0 && <ins className="page-change-prop__new"><Pieces pieces={diff.added} /></ins>}
            </div>
          )}
          {!editing && change.op === 'delete' && <p className="page-change-card__why">Accepting removes {change.target.kind === 'row' ? 'the row' : 'the block'}.</p>}
          {editing && blockValue && (
            <label className="page-change-edit">
              <span>Proposed block content</span>
              <textarea value={blockDraft} onChange={(event) => setBlockDraft(event.target.value)} rows={5} spellCheck={false} />
            </label>
          )}
          {editing && rowValue && (
            <div className="page-change-edit">
              <label><span>Proposed row fields</span><textarea value={rowValuesDraft} onChange={(event) => setRowValuesDraft(event.target.value)} rows={4} spellCheck={false} /></label>
            </div>
          )}
          {(draftError || stale || (error && !stale)) && <p role="alert" className="page-change-card__error">{draftError ?? stale ?? error}</p>}
          <footer className="page-change-prop__actions">
            <button type="button" className="page-change-primary" disabled={loading} onClick={() => editing ? acceptEdited() : void onAccept(change)}>Accept</button>
            {canEditProposal(change) && <button type="button" disabled={loading} onClick={() => editing ? acceptEdited() : setEditing(true)}>Edit & accept</button>}
            <button type="button" className="page-change-quiet" disabled={loading} onClick={() => void onDismiss(change)}>Dismiss</button>
            <span className="page-change-prop__from">{from}</span>
          </footer>
        </article>
      );
    }
    const state = change.proposalState === 'dismissed' ? 'dismissed' : change.applicationState === 'reverted' ? 'reverted' : change.proposalState === 'accepted' ? 'accepted' : 'applied';
    const what = showTarget ? ` ${change.target.kind === 'row' ? (change.op === 'insert' ? 'a new row' : 'a row') : change.op === 'insert' ? `a new block ${targetName(change)}` : targetName(change)}` : '';
    const lead = state === 'dismissed' ? `Suggestion dismissed${what}` : state === 'reverted' ? `Undone${what}` : state === 'accepted' ? `You accepted this rewrite${what}` : `${change.op === 'insert' ? 'Agent added' : change.op === 'delete' ? 'Agent removed' : 'Agent updated'}${what.replace(' a new block', '').replace(' a new row', ' a row')}`;
    return (
      <div className="page-change-line" data-state={state} data-quiet={quiet || undefined}>
        {!quiet && <Sparkles size={12} strokeWidth={1.7} aria-hidden="true" />}
        {(!quiet || state === 'dismissed' || state === 'reverted') && <span className="page-change-line__lead">{lead}</span>}
        {!quiet && <><span aria-hidden="true">·</span><time dateTime={new Date(change.createdAt).toISOString()}>{relativeTime(change.createdAt)}</time></>}
        {state !== 'dismissed' && from}
        {(draftError || stale || error) && <span role="alert" className="page-change-card__error">{draftError ?? stale ?? error}</span>}
        {(!quiet || state === 'dismissed' || state === 'reverted' || (origin && (origin.cited.length > 0 || origin.read || origin.run))) && <span aria-hidden="true">·</span>}
        {state === 'dismissed' && <button type="button" className="page-change-link" disabled={loading} onClick={() => void onReopen(change)}>Show again</button>}
        {isPageChangeRevertible(change) && <button type="button" className="page-change-link" disabled={loading} onClick={() => void onRevert(change)}>Undo</button>}
        {isPageChangeRedoable(change) && <button type="button" className="page-change-link" disabled={loading} onClick={() => void onRedo(change)}>Restore</button>}
      </div>
    );
  }

  return (
    <article className="page-change-card" data-state={change.proposalState ?? change.applicationState ?? 'recorded'}>
      <header className="page-change-card__header">
        <div className="page-change-card__title">
          <span className="page-change-tag">{isProposal ? 'Suggestion' : change.applicationState === 'reverted' ? 'Undone' : change.source.kind === 'user' ? 'Page updated' : 'Agent updated'}</span>
          <span>{isProposal ? operationLabel(change) : change.proposalState === 'accepted' ? `You accepted this rewrite · ${targetName(change)}` : targetName(change)}</span>
        </div>
        <time dateTime={new Date(change.createdAt).toISOString()}>{relativeTime(change.createdAt)}</time>
      </header>

      {change.proposalState === 'pending' && <p className="page-change-card__why">You edited this content, so it asks first.</p>}
      {change.op === 'delete' && <p className="page-change-card__why">Accepting removes {change.target.kind === 'row' ? 'the row' : 'the block'}.</p>}
      {change.op === 'move' && <p className="page-change-card__why">Accepting moves this block to the proposed position.</p>}
      {isProposal && blockValue && <pre className="page-change-preview">{previewText(blockValue)}</pre>}
      {isProposal && rowValue && <pre className="page-change-preview">{JSON.stringify(rowValue, null, 2)}</pre>}

      {editing && blockValue && (
        <label className="page-change-edit">
          <span>Proposed block content</span>
          <textarea value={blockDraft} onChange={(event) => setBlockDraft(event.target.value)} rows={5} spellCheck={false} />
        </label>
      )}
      {editing && rowValue && (
        <div className="page-change-edit">
          <label><span>Proposed row fields</span><textarea value={rowValuesDraft} onChange={(event) => setRowValuesDraft(event.target.value)} rows={4} spellCheck={false} /></label>
          {change.target.kind === 'row' && change.target.body && (
            <label><span>Proposed row text</span><textarea value={rowBodyDraft} onChange={(event) => setRowBodyDraft(event.target.value)} rows={3} /></label>
          )}
        </div>
      )}

      {(draftError || stale || (error && !stale)) && <p role="alert" className="page-change-card__error">{draftError ?? stale ?? error}</p>}
      {source && <SourceTrace source={source} onOpenSource={onOpenSource} />}

      <footer className="page-change-card__actions">
        {change.proposalState === 'pending' && (
          <>
            <button type="button" className="page-change-primary" disabled={loading} onClick={() => editing ? acceptEdited() : void onAccept(change)}>Accept</button>
            {canEditProposal(change) && <button type="button" disabled={loading} onClick={() => editing ? acceptEdited() : setEditing(true)}>{editing ? 'Edit & accept' : 'Edit & accept'}</button>}
            <button type="button" disabled={loading} onClick={() => void onDismiss(change)}>Dismiss</button>
          </>
        )}
        {change.proposalState === 'dismissed' && <button type="button" disabled={loading} onClick={() => void onReopen(change)}>Show again</button>}
        {isPageChangeRevertible(change) && <button type="button" disabled={loading} onClick={() => void onRevert(change)}>Undo</button>}
        {isPageChangeRedoable(change) && <button type="button" disabled={loading} onClick={() => void onRedo(change)}>Restore</button>}
      </footer>
    </article>
  );
}
