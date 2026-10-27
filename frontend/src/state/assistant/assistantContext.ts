import type { MichiContextItem } from 'michi-shared';
import type { MichiAssistantPage } from '../content/assistantBridge';
import { ATTACHED_QUOTE_SOURCE, type AnyQuoteSource } from '../../lib/quoteFormat';

/** Where the assistant panel was opened from, resolved to what the user sees. */
export interface AssistantPageView extends MichiAssistantPage {
  /** Workspace document title / pane title, when known. */
  title?: string;
}

export const CONTEXT_TEXT_LIMIT = 600;
/** Chips shown before the rest collapse into `+N`. */
export const VISIBLE_ATTACHMENTS = 3;

const KIND_LABEL: Record<MichiContextItem['kind'], string> = {
  thread: 'Thread',
  node: 'Thread',
  block: 'Block',
  row: 'Row',
};

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, limit: number): string {
  const glyphs = Array.from(text);
  return glyphs.length <= limit ? text : `${glyphs.slice(0, limit - 1).join('').trimEnd()}…`;
}

/** The chip's text: `Thread · S7 迁移 MCP`. */
export function attachmentChipLabel(item: MichiContextItem): string {
  return `${KIND_LABEL[item.kind]} · ${oneLine(item.title) || 'Untitled'}`;
}

/** Header caption after `ASSISTANT · ON …`; null when the page has no name worth showing. */
export function assistantPageCaption(page: AssistantPageView | null | undefined): string | null {
  switch (page?.kind) {
    case 'home': return 'Home';
    case 'page': return 'Workspace document';
    case 'threads': return 'All threads';
    case 'pane': return page.title ? oneLine(page.title) : null;
    default: return null;
  }
}

/** Stable identity of a page, to tell whether the assistant already heard about it. */
export function assistantPageKey(page: AssistantPageView | null | undefined): string | null {
  if (!page || page.kind === 'other') return null;
  return [page.kind, page.projectId ?? '', page.nodeId ?? ''].join(':');
}

function pageLine(page: AssistantPageView): string | null {
  const title = page.title ? oneLine(page.title) : '';
  switch (page.kind) {
    case 'home': return 'On screen: Home';
    case 'threads': return 'On screen: All threads';
    case 'page': {
      const name = title ? `Workspace document “${title}”` : 'Workspace document';
      return `On screen: ${name}${page.projectId ? ` (michi://page/${page.projectId})` : ''}`;
    }
    case 'pane': {
      const name = title ? `Michi thread “${title}”` : 'Michi thread';
      return `On screen: ${name}${page.nodeId ? ` (michi://node/${page.nodeId})` : ''}`;
    }
    default: return null;
  }
}

/** A link the assistant can act on for each kind of item. */
function itemRef(item: MichiContextItem): string {
  switch (item.kind) {
    case 'thread': return `michi://node/${item.id}`;
    case 'node': return `michi://node/${item.id}`;
    // A block opens where it sits in its document (the copy-link form).
    case 'block': return item.projectId ? `michi://page/${encodeURIComponent(item.projectId)}?block=${encodeURIComponent(item.id)}` : item.id;
    default: return item.projectId ? `${item.id} in michi://page/${item.projectId}` : item.id;
  }
}

function itemLine(item: MichiContextItem): string {
  const title = oneLine(item.title) || 'Untitled';
  const text = item.text ? clip(oneLine(item.text), CONTEXT_TEXT_LIMIT) : '';
  return `- ${item.kind}: ${title} (${itemRef(item)})${text ? ` — ${text}` : ''}`;
}

/**
 * The quoted context block a send carries: an `On screen:` line, then one line
 * per attached item. Null when there is nothing to say. It travels as the
 * message's quote, so the agent reads it as material, not as instructions.
 */
export function formatAssistantContext(
  page: AssistantPageView | null | undefined,
  attachments: readonly MichiContextItem[],
): string | null {
  const lines: string[] = [];
  const screen = page ? pageLine(page) : null;
  if (screen) lines.push(screen);
  for (const item of attachments) lines.push(itemLine(item));
  return lines.length > 0 ? lines.join('\n') : null;
}

const CONTEXT_START = /^(On screen: |- (thread|node|block|row): )/;

/**
 * The quote's framing on the wire when it is replayed from its text alone (a
 * queued send, a steer, a retry): attached context when it opens the way
 * formatAssistantContext writes it, else a selection from a reply.
 */
export function quoteSourceOf(quote: string | null | undefined): AnyQuoteSource | undefined {
  return quote && CONTEXT_START.test(quote.trimStart()) ? ATTACHED_QUOTE_SOURCE : undefined;
}

/**
 * Whether an attached-context quote also carries a selection the user was
 * replying to: TPane sends the context block (formatAssistantContext: one
 * `On screen:` or `- kind:` line each) and then, after a blank line, the
 * selection, if any.
 */
export function attachedQuoteHasSelection(quote: string): boolean {
  const lines = quote.trim().split('\n');
  let i = 0;
  while (i < lines.length && CONTEXT_START.test(lines[i])) i += 1;
  return lines.slice(i).join('\n').trim() !== '';
}

/** Same id twice (e.g. two Ask presses on one block) stays one chip. */
export function mergeAttachments(
  current: readonly MichiContextItem[],
  added: readonly MichiContextItem[],
): MichiContextItem[] {
  const key = (item: MichiContextItem) => `${item.kind}:${item.id}`;
  const seen = new Set(current.map(key));
  const next = [...current];
  for (const item of added) {
    if (seen.has(key(item))) continue;
    seen.add(key(item));
    next.push(item);
  }
  return next;
}

/** Join attached context and a selection without losing either. */
export function mergeContextQuote(context: string | null | undefined, quote: string | null | undefined): string | null {
  const text = context?.trim() ?? '';
  if (!text) return quote ?? null;
  return quote?.trim() ? `${text}\n\n${quote}` : text;
}
