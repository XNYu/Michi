/**
 * rehype plugin: marks passages a reader quoted from this text.
 *
 * A quote is what the reader selected in the rendered message, so it is
 * matched against the rendered text, not the Markdown source, and whitespace
 * is ignored on both sides: a selection reports line, cell and block breaks
 * in its own way. Each quote marks its first occurrence. Quotes that overlap
 * share one mark that lists both keys.
 *
 * A mark is a `span` whose `dataMichiQuoteMark` property lists the quote keys.
 * Inside one block it is a single span, cutting emphasis at its edges; a
 * passage across blocks gets one span per block. Links, inline code, inline
 * math and mention chips are never cut: a mark covers them whole. Code blocks
 * and display math render from their own text, so a mark skips them.
 *
 * Runs after sanitize, so Markdown and raw HTML cannot forge a mark.
 */

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

export interface MarkdownQuote {
  /** Names the quote in the keys of the marks it produces. */
  key: string;
  /** The passage as the reader selected it. */
  text: string;
}

export interface QuoteMarksOptions {
  quotes: readonly MarkdownQuote[];
}

/** hast property on a mark: the keys of the quotes it covers. */
export const QUOTE_MARK_PROPERTY = 'dataMichiQuoteMark';

/** The quote keys of a mark this plugin made, or null for any other node. */
export function quoteMarkKeys(node: unknown): string[] | null {
  const value = (node as HastNode | undefined)?.properties?.[QUOTE_MARK_PROPERTY];
  return Array.isArray(value) && value.length > 0 ? value.map(String) : null;
}

/** Contains blocks: recursed into, never inside a mark. */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'details', 'dd', 'div', 'dl', 'dt',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li',
  'main', 'nav', 'ol', 'p', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr', 'ul',
]);
/** Inline elements that only style their text, so a mark may cut them in two. */
const SPLIT_TAGS = new Set(['b', 'del', 'em', 'i', 'ins', 'mark', 's', 'small', 'span', 'strong', 'sub', 'sup', 'u']);
const MATH_CLASSES = ['katex', 'math', 'math-inline'];
const DISPLAY_MATH_CLASSES = ['katex-display', 'math-display'];
const WHITESPACE = /\s/;

/**
 * - block: recursed into, never inside a mark
 * - skip: left alone (code blocks and display math render from their own text)
 * - atom: inline; a mark covers it whole or not at all
 * - split: inline styling a mark may cut at its edges
 */
type Kind = 'text' | 'block' | 'skip' | 'atom' | 'split';

interface Walk {
  lengths: WeakMap<HastNode, number>;
  blocks: WeakMap<HastNode, boolean>;
}

function classes(node: HastNode): string[] {
  const value = node.properties?.className;
  if (Array.isArray(value)) return value.map(String);
  return typeof value === 'string' ? value.split(/\s+/) : [];
}

function textLength(node: HastNode, walk: Walk): number {
  if (node.type === 'text') return node.value?.length ?? 0;
  const known = walk.lengths.get(node);
  if (known !== undefined) return known;
  let length = 0;
  for (const child of node.children ?? []) length += textLength(child, walk);
  walk.lengths.set(node, length);
  return length;
}

function containsBlock(node: HastNode, walk: Walk): boolean {
  const known = walk.blocks.get(node);
  if (known !== undefined) return known;
  const found = (node.children ?? []).some((child) => child.type === 'element'
    && (BLOCK_TAGS.has(child.tagName ?? '') || child.tagName === 'pre' || containsBlock(child, walk)));
  walk.blocks.set(node, found);
  return found;
}

function kindOf(node: HastNode, walk: Walk): Kind {
  if (node.type === 'text') return 'text';
  if (node.type !== 'element') return 'atom';
  const tag = node.tagName ?? '';
  const names = classes(node);
  if (tag === 'pre' || names.some((name) => DISPLAY_MATH_CLASSES.includes(name))) return 'skip';
  if (BLOCK_TAGS.has(tag)) return 'block';
  if (names.some((name) => MATH_CLASSES.includes(name)) || names.includes('mention-chip') || quoteMarkKeys(node)) return 'atom';
  if (containsBlock(node, walk)) return SPLIT_TAGS.has(tag) ? 'block' : 'skip';
  return SPLIT_TAGS.has(tag) ? 'split' : 'atom';
}

function allText(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(allText).join('');
}

interface MarkRange {
  start: number;
  end: number;
  keys: string[];
}

/** Ranges in the rendered text, overlapping quotes merged into one. */
function findRanges(text: string, quotes: readonly MarkdownQuote[]): MarkRange[] {
  const chars: string[] = [];
  const offsets: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (WHITESPACE.test(text[i])) continue;
    chars.push(text[i]);
    offsets.push(i);
  }
  const haystack = chars.join('');
  const found: MarkRange[] = [];
  for (const quote of quotes) {
    const needle = quote.text.replace(/\s+/g, '');
    const at = needle ? haystack.indexOf(needle) : -1;
    if (at < 0) continue;
    found.push({ start: offsets[at], end: offsets[at + needle.length - 1] + 1, keys: [quote.key] });
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: MarkRange[] = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last && range.start < last.end) {
      last.end = Math.max(last.end, range.end);
      last.keys.push(...range.keys);
    } else {
      merged.push(range);
    }
  }
  return merged;
}

function textNode(source: HastNode, value: string): HastNode | null {
  return value ? { ...source, value } : null;
}

/** Cuts a text node or styling element into the parts before, inside and after [start, end). */
function cut(node: HastNode, start: number, end: number, walk: Walk): [HastNode | null, HastNode | null, HastNode | null] {
  if (node.type === 'text') {
    const value = node.value ?? '';
    return [textNode(node, value.slice(0, start)), textNode(node, value.slice(start, end)), textNode(node, value.slice(end))];
  }
  const before: HastNode[] = [];
  const inside: HastNode[] = [];
  const after: HastNode[] = [];
  let position = 0;
  for (const child of node.children ?? []) {
    const length = textLength(child, walk);
    const from = position;
    const to = position + length;
    position = to;
    if (to <= start) before.push(child);
    else if (from >= end) after.push(child);
    else if (from >= start && to <= end) inside.push(child);
    else {
      const kind = kindOf(child, walk);
      if (kind === 'text' || kind === 'split') {
        const [b, i, a] = cut(child, Math.max(0, start - from), Math.min(length, end - from), walk);
        if (b) before.push(b);
        if (i) inside.push(i);
        if (a) after.push(a);
      } else {
        inside.push(child);
      }
    }
  }
  const part = (children: HastNode[]) => (children.length > 0 ? { ...node, children } : null);
  return [part(before), part(inside), part(after)];
}

function isBlank(node: HastNode): boolean {
  return node.type === 'text' && !(node.value ?? '').trim();
}

/** `parent`'s children with [start, end) (offsets in its text) marked. */
function markChildren(parent: HastNode, start: number, end: number, keys: readonly string[], walk: Walk): HastNode[] {
  const out: HastNode[] = [];
  let run: HastNode[] = [];
  const flush = () => {
    if (run.length === 0) return;
    // Whitespace between blocks gets no mark: an empty bordered span would draw a stray line.
    if (run.every(isBlank)) out.push(...run);
    else out.push({ type: 'element', tagName: 'span', properties: { [QUOTE_MARK_PROPERTY]: [...keys] }, children: run });
    run = [];
  };
  let position = 0;
  for (const child of parent.children ?? []) {
    const length = textLength(child, walk);
    const from = position;
    const to = position + length;
    position = to;
    if (to <= start || from >= end) {
      flush();
      out.push(child);
      continue;
    }
    const kind = kindOf(child, walk);
    if (kind === 'block') {
      flush();
      out.push({ ...child, children: markChildren(child, Math.max(0, start - from), Math.min(length, end - from), keys, walk) });
    } else if (kind === 'skip') {
      flush();
      out.push(child);
    } else if (kind === 'atom' || (from >= start && to <= end)) {
      run.push(child);
    } else {
      const [before, inside, after] = cut(child, Math.max(0, start - from), Math.min(length, end - from), walk);
      if (before) {
        flush();
        out.push(before);
      }
      if (inside) run.push(inside);
      if (after) {
        flush();
        out.push(after);
      }
    }
  }
  flush();
  return out;
}

export function rehypeQuoteMarks(options: QuoteMarksOptions) {
  return function transform(tree: HastNode) {
    const quotes = options?.quotes ?? [];
    if (quotes.length === 0 || !Array.isArray(tree.children)) return;
    const ranges = findRanges(allText(tree), quotes);
    const walk: Walk = { lengths: new WeakMap(), blocks: new WeakMap() };
    for (const range of ranges) {
      tree.children = markChildren(tree, range.start, range.end, range.keys, walk);
    }
  };
}
