import type { MichiPageBlock } from 'michi-shared';
import type { MichiPageEditOp } from './editorTypes';
import { isObj, objects, str } from './michiPageModel';
import { segmentId, splitMarkdown, type MdSegmentKind } from './markdownSegments';

// Build presentation edits consumed by the native Page adapter.

/**
 * What a person may rewrite here. Michi also lets a database be edited, cell by
 * cell; that belongs to the database views, not the page's own editor.
 */
export const EDITABLE_TYPES: ReadonlySet<string> = new Set(['markdown', 'heading', 'callout', 'checklist']);

/**
 * Editor limits for human-authored text and checklist items.
 */
export const MICHI_TEXT_MAX = 2000;
export const MICHI_HEADING_MAX = 200;
export const MICHI_CHECKLIST_MAX_ITEMS = 50;

/** The block's id when it has one; a block without one cannot be named in an edit. */
export function blockIdOf(block: MichiPageBlock): string | null {
  return typeof block.id === 'string' && block.id ? block.id : null;
}

export function isEditableBlock(block: MichiPageBlock): boolean {
  return blockIdOf(block) != null && EDITABLE_TYPES.has(block.type);
}

/** Set by Michi once a person changed the block; the agent then keeps it as it is. */
export function isEditedBlock(block: MichiPageBlock): boolean {
  return isObj(block.edit);
}

/** The block an agent's note says may be out of date, when this block is such a note. */
export function staleTargetOf(block: MichiPageBlock): string | null {
  return typeof block.staleFor === 'string' && block.staleFor ? block.staleFor : null;
}

/** Leading blank lines and trailing space carry nothing in Markdown, so they neither count as a change nor get saved. */
export function tidy(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
}

/** One line, as a heading holds it. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The whole block with its changes; Michi marks the block as the person's itself, so its old mark is not sent back. */
export function updateOp(block: MichiPageBlock, changes: Record<string, unknown>): MichiPageEditOp | null {
  const id = blockIdOf(block);
  if (!id) return null;
  const { edit: _edit, ...rest } = block;
  return { op: 'update', id, block: { ...rest, ...changes, id, type: block.type } };
}

/**
 * The text change a markdown, heading or callout editor makes, or null when
 * there is none to send: unchanged, or emptied (an emptied block stays as it was).
 * A callout's `title` (one line) goes too when it changed; emptied, the callout
 * has none (`title: undefined`, which the sent block leaves out).
 */
export function textChanges(block: MichiPageBlock, draft: string, title?: string): Record<string, unknown> | null {
  const before = str(block.text);
  if (block.type === 'heading') {
    const text = oneLine(draft);
    return text && text !== oneLine(before) ? { text } : null;
  }
  const out: Record<string, unknown> = {};
  const text = tidy(draft);
  if (text && text !== tidy(before)) out.text = text;
  if (block.type === 'callout' && title !== undefined) {
    const next = oneLine(title);
    if (next !== oneLine(str(block.title))) out.title = next || undefined;
  }
  return Object.keys(out).length ? out : null;
}

export interface ChecklistDraftItem {
  text: string;
  done: boolean;
}

/** A checklist's items as the editor starts them. */
export function checklistItems(block: MichiPageBlock): ChecklistDraftItem[] {
  return objects(block.items).map((it) => ({ text: str(it.text), done: it.done === true }));
}

/**
 * A checklist editor's result: blank items dropped (Michi keeps none), the
 * title kept when emptied. `empty` when no item is left, which Michi refuses.
 */
export function checklistChanges(
  block: MichiPageBlock,
  title: string,
  items: readonly ChecklistDraftItem[],
): Record<string, unknown> | null | 'empty' {
  const kept = items.map((it) => ({ text: oneLine(it.text), done: it.done })).filter((it) => it.text);
  if (!kept.length) return 'empty';
  const nextTitle = oneLine(title) || str(block.title);
  const before = checklistItems(block).map((it) => ({ text: oneLine(it.text), done: it.done }));
  const same = nextTitle === str(block.title)
    && kept.length === before.length
    && kept.every((it, i) => it.text === before[i].text && it.done === before[i].done);
  return same ? null : { title: nextTitle, items: kept };
}

/** The checklist with one item ticked or unticked; null when there is no such item. */
export function toggledChecklist(block: MichiPageBlock, index: number): MichiPageBlock | null {
  const items = objects(block.items);
  if (index < 0 || index >= items.length) return null;
  return { ...block, items: items.map((it, i) => (i === index ? { ...it, done: it.done !== true } : it)) };
}

/** What the margin's + adds below a block. Michi adds Markdown only, so each kind is written as its Markdown. */
export type InsertKind = 'text' | 'heading' | 'todo' | 'callout';

export const INSERT_KINDS: readonly InsertKind[] = ['text', 'heading', 'todo', 'callout'];

/** The Markdown an add-block editor's words become; null when nothing was written. */
export function insertMarkdown(kind: InsertKind, draft: string): string | null {
  if (kind === 'heading') {
    const text = oneLine(draft);
    return text ? `## ${text}` : null;
  }
  const lines = draft.split(/\r?\n/).map((l) => l.trim());
  if (kind === 'todo') {
    const items = lines.filter(Boolean);
    return items.length ? items.map((l) => `- [ ] ${l}`).join('\n') : null;
  }
  const text = tidy(draft);
  if (!text) return null;
  if (kind === 'callout') return text.split(/\r?\n/).map((l) => (l.trim() ? `> ${l}` : '>')).join('\n');
  return text;
}

/** Markdown added after the block `after`, or at the top of the page when `after` is null. */
export function insertOp(after: string | null, markdown: string): MichiPageEditOp {
  const block = { type: 'markdown', text: markdown };
  return after == null ? { op: 'insert', after: null, parent: null, block } : { op: 'insert', after, block };
}

/**
 * A database shown on the page by reference, added after the block `after`:
 * Michi assigns the block an ID; the database keeps its own title and views.
 */
export function databaseRefOp(after: string, databaseId: string): MichiPageEditOp {
  return { op: 'insert', after, block: { type: 'database-ref', databaseId } };
}

export function deleteOps(ids: readonly string[]): MichiPageEditOp[] {
  return ids.map((id) => ({ op: 'delete', id }));
}

export function releaseOp(id: string): MichiPageEditOp {
  return { op: 'release', id };
}

/**
 * Move the top-level block `id` into the gap before `order[before]` (`before`
 * = order.length is the end). Null when that leaves it where it is.
 */
export function moveToOp(order: readonly string[], id: string, before: number): MichiPageEditOp | null {
  const from = order.indexOf(id);
  if (from < 0 || before < 0 || before > order.length || before === from || before === from + 1) return null;
  const rest = order.filter((x) => x !== id);
  const at = before > from ? before - 1 : before;
  return { op: 'move', id, after: at === 0 ? null : rest[at - 1], parent: null };
}

/** One place up (-1) or down (1) among the page's top-level blocks. */
export function moveStepOp(order: readonly string[], id: string, step: -1 | 1): MichiPageEditOp | null {
  const from = order.indexOf(id);
  if (from < 0) return null;
  return moveToOp(order, id, step < 0 ? from - 1 : from + 2);
}

/** The page's blocks with `replacements` swapped in by id, at any depth inside containers. */
export function replaceBlocks(
  blocks: readonly MichiPageBlock[],
  replacements: ReadonlyMap<string, MichiPageBlock>,
): MichiPageBlock[] {
  if (!replacements.size) return blocks as MichiPageBlock[];
  function kids(list: unknown[]): unknown[] {
    return list.map((c) => (isObj(c) && typeof c.type === 'string' ? swap(c as MichiPageBlock) : c));
  }
  function swap(b: MichiPageBlock): MichiPageBlock {
    const id = blockIdOf(b);
    const own = id ? replacements.get(id) : undefined;
    if (own) return own;
    if (b.type === 'toggle' && Array.isArray(b.blocks)) return { ...b, blocks: kids(b.blocks) };
    if (b.type === 'columns' && Array.isArray(b.columns)) {
      return { ...b, columns: b.columns.map((c) => (Array.isArray(c) ? kids(c) : c)) };
    }
    if (b.type === 'tabs' && Array.isArray(b.tabs)) {
      return { ...b, tabs: b.tabs.map((t) => (isObj(t) && Array.isArray(t.blocks) ? { ...t, blocks: kids(t.blocks) } : t)) };
    }
    return b;
  }
  return blocks.map(swap);
}

// ── segments ─────────────────────────────────────────────────────

const PIECES = new WeakMap<MichiPageBlock, MichiPageBlock[] | null>();

/**
 * An agent's Markdown block cut into the pieces a person points at, one block
 * each with id `<block>~<n>`, the way Michi draws and counts it: a page edit
 * naming a piece makes Michi cut the block there, so only the touched piece is
 * marked "You edited". Each piece keeps the block's sources, and the first its
 * `staleFor`. Null when the block stays whole: not Markdown, no id, one piece,
 * or a person's own (edited as the one text it is). Cached per block object.
 */
export function markdownPieces(block: MichiPageBlock): MichiPageBlock[] | null {
  const cached = PIECES.get(block);
  if (cached !== undefined) return cached;
  const id = blockIdOf(block);
  let pieces: MichiPageBlock[] | null = null;
  if (block.type === 'markdown' && id && !isEditedBlock(block)) {
    const segments = splitMarkdown(str(block.text));
    if (segments.length >= 2) {
      pieces = segments.map((s) => ({
        id: segmentId(id, s.index),
        type: 'markdown',
        text: s.text,
        ...(block.sources ? { sources: block.sources } : {}),
        ...(s.index === 0 && block.staleFor !== undefined ? { staleFor: block.staleFor } : {}),
      }));
    }
  }
  PIECES.set(block, pieces);
  return pieces;
}

/** One thing on the page a person points at: a block, or one piece of an agent's Markdown block. */
export interface PageUnit {
  block: MichiPageBlock;
  /** The Markdown block this piece was cut from. */
  segmentOf?: string;
}

const UNITS = new WeakMap<MichiPageBlock, PageUnit[]>();

/** A list of blocks as the units drawn for it, each agent Markdown block as its pieces. */
export function pageUnits(blocks: readonly MichiPageBlock[]): PageUnit[] {
  return blocks.flatMap((b) => {
    let units = UNITS.get(b);
    if (!units) {
      const pieces = markdownPieces(b);
      const of = blockIdOf(b);
      units = pieces && of ? pieces.map((piece) => ({ block: piece, segmentOf: of })) : [{ block: b }];
      UNITS.set(b, units);
    }
    return units;
  });
}

export type { MdSegmentKind };

// ── drafts ───────────────────────────────────────────────────────

/** What an open editor holds: words (a callout's with its title), or a checklist's title and items. */
export type EditorDraft =
  | { kind: 'text'; text: string; title?: string }
  | { kind: 'checklist'; title: string; items: ChecklistDraftItem[] };

/** A draft as plain text, for Copy. */
export function draftText(draft: EditorDraft): string {
  if (draft.kind === 'text') return [oneLine(draft.title ?? ''), draft.text].filter(Boolean).join('\n');
  const items = draft.items.filter((it) => it.text.trim()).map((it) => `- [${it.done ? 'x' : ' '}] ${oneLine(it.text)}`);
  return [oneLine(draft.title), ...items].filter(Boolean).join('\n');
}

/**
 * A draft as the Markdown it would be as a new block, so it can be added back
 * when the block it was editing is gone. `type` is the edited block's type,
 * or the kind of block being added. Null when there is nothing to keep.
 */
export function draftMarkdown(type: string, draft: EditorDraft): string | null {
  if (draft.kind === 'checklist') {
    const items = draft.items.map((it) => ({ text: oneLine(it.text), done: it.done })).filter((it) => it.text);
    const title = oneLine(draft.title);
    if (!items.length && !title) return null;
    const lines = items.map((it) => `- [${it.done ? 'x' : ' '}] ${it.text}`).join('\n');
    return title ? (lines ? `**${title}**\n\n${lines}` : `**${title}**`) : lines;
  }
  switch (type) {
    case 'heading':
      return insertMarkdown('heading', draft.text);
    case 'callout': {
      const title = oneLine(draft.title ?? '');
      return insertMarkdown('callout', title ? `**${title}**\n${draft.text}` : draft.text);
    }
    case 'todo':
      return insertMarkdown('todo', draft.text);
    default:
      return insertMarkdown('text', draft.text);
  }
}

// ── keeping what did not change ──────────────────────────────────

const JSON_OF = new WeakMap<object, string>();
function jsonOf(value: object): string {
  let json = JSON_OF.get(value);
  if (json === undefined) {
    json = JSON.stringify(value);
    JSON_OF.set(value, json);
  }
  return json;
}

/** `next`, or `prev` when the two hold the same data, so what depends on it sees no change. */
export function shareValue<T extends object>(prev: T, next: T): T {
  return prev === next || jsonOf(prev) === jsonOf(next) ? prev : next;
}

/**
 * `next` with each block that did not change since `prev` kept as the same
 * object (matched by id, or by place when it has none), so memoized blocks
 * skip a reload that left them alone; `prev` itself when nothing changed.
 */
export function shareBlocks(prev: readonly MichiPageBlock[], next: readonly MichiPageBlock[]): MichiPageBlock[] {
  const byId = new Map<string, MichiPageBlock>();
  for (const b of prev) {
    const id = blockIdOf(b);
    if (id) byId.set(id, b);
  }
  let same = prev.length === next.length;
  const out = next.map((b, i) => {
    const id = blockIdOf(b);
    const old = id ? byId.get(id) : prev[i];
    const kept = old && jsonOf(old) === jsonOf(b) ? old : b;
    if (kept !== prev[i]) same = false;
    return kept;
  });
  return same ? (prev as MichiPageBlock[]) : out;
}

// ── what an editor opened on ─────────────────────────────────────

/**
 * What a block says, as an editor saw it when it opened: its kind and words
 * (text, title, items, level, tone) and, for a piece, the block it was cut
 * from. Ids alone do not say this: an agent may rewrite a block keeping its
 * id, and a paragraph added above shifts which paragraph `b~1` names.
 */
export function blockFingerprint(block: MichiPageBlock, segmentOf?: string): string {
  return JSON.stringify([
    segmentOf ?? null,
    block.type,
    str(block.text),
    str(block.title),
    block.type === 'checklist' ? checklistItems(block) : null,
    block.level ?? null,
    block.tone ?? null,
  ]);
}

/** The lists of blocks a container holds. */
function childLists(block: MichiPageBlock): unknown[][] {
  if (block.type === 'toggle' && Array.isArray(block.blocks)) return [block.blocks];
  if (block.type === 'columns' && Array.isArray(block.columns)) return block.columns.filter(Array.isArray);
  if (block.type === 'grid' && Array.isArray(block.regions)) {
    return block.regions.flatMap((region) => (isObj(region) && Array.isArray(region.blocks) ? [region.blocks] : []));
  }
  if (block.type === 'tabs' && Array.isArray(block.tabs)) {
    return block.tabs.flatMap((t) => (isObj(t) && Array.isArray(t.blocks) ? [t.blocks] : []));
  }
  return [];
}

/** The id of the block (or Markdown piece) anywhere on the page that says what `fingerprint` recorded; null when none does. */
export function findByFingerprint(blocks: readonly unknown[], fingerprint: string): string | null {
  for (const raw of blocks) {
    if (!isObj(raw) || typeof raw.type !== 'string') continue;
    const b = raw as MichiPageBlock;
    const id = blockIdOf(b);
    const pieces = markdownPieces(b);
    if (pieces && id) {
      const piece = pieces.find((p) => blockFingerprint(p, id) === fingerprint);
      if (piece) return blockIdOf(piece);
    } else if (id && blockFingerprint(b) === fingerprint) {
      return id;
    }
    for (const list of childLists(b)) {
      const found = findByFingerprint(list, fingerprint);
      if (found) return found;
    }
  }
  return null;
}
