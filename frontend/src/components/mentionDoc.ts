import type { MentionRecord } from './mentions';

/**
 * Bridge between the composer's controlled `{ value, mentions }` contract and a
 * TipTap/ProseMirror document.
 *
 * The store, submit path (`expandMentions`), queue and draft persistence all
 * speak `{ value: string, mentions: MentionRecord[] }` where each mention is a
 * char-offset range `[start, end)` into `value` covering its `@label` text.
 * TipTap instead owns a node tree where mentions are atomic inline nodes. These
 * two functions convert losslessly between the two so the rest of the app never
 * has to learn about ProseMirror.
 *
 * `value` is a markdown string. The editor's mark input rules consume typed
 * syntax (`**bold**` becomes a bold mark, asterisks gone), so `docToDraft`
 * re-emits the markers for bold/italic/strike/code and `draftToDoc` parses
 * them back into marks. The invariant that matters is wire stability: the
 * characters the user typed are the characters that get submitted, and
 * `docToDraft(draftToDoc(value, mentions)).value === value`. Mention offsets
 * are computed against the marker-bearing string in the same pass, so they
 * always index into the final `value`.
 *
 * Known limitation: a mark span that crosses a mention boundary (bold text on
 * both sides of an atomic mention) serializes fine but parses back as literal
 * marker characters — the value is unchanged, only the WYSIWYG styling is lost
 * on draft restore.
 *
 * Canonical document shape we emit: a single `paragraph` whose inline content is
 * a run of `text`, `hardBreak` (one per `\n`) and `mention` nodes. TipTap may
 * hand us a multi-paragraph doc (e.g. after a paste); `docToDraft` tolerates
 * that by joining block boundaries with `\n`.
 */

/** Minimal subset of ProseMirror/TipTap `getJSON()` output we read. */
export interface PMNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string }>;
  content?: PMNode[];
}

const MENTION = 'mention';

/** Attrs we store on each mention node — carries everything MentionRecord needs. */
export interface MentionAttrs {
  refId: string;
  label: string;
  kind: MentionRecord['kind'];
}

// Emphasis marks we serialize, in fixed outer→inner nesting order. `code` is
// handled separately: TipTap's Code mark excludes all others, and markdown
// code spans can't contain nested formatting.
const MARK_DELIM: Record<string, string> = {
  bold: '**',
  italic: '*',
  strike: '~~',
};
const MARK_ORDER = ['bold', 'italic', 'strike'];

const emphasisMarks = (node: PMNode): string[] => {
  const types = (node.marks ?? []).map((m) => m.type);
  return MARK_ORDER.filter((t) => types.includes(t));
};

const hasCodeMark = (node: PMNode): boolean =>
  (node.marks ?? []).some((m) => m.type === 'code');

// Markdown code span: fence one backtick longer than the longest run inside,
// space-padded only when the content starts/ends with a backtick (the pad is
// what keeps the fence unambiguous; the parser strips exactly this case).
const codeSpan = (text: string): string => {
  const runs = text.match(/`+/g);
  const fence = '`'.repeat((runs ? Math.max(...runs.map((r) => r.length)) : 0) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return fence + pad + text + pad + fence;
};

/**
 * Serialize a TipTap doc JSON into the controlled `{ value, mentions }` form.
 *
 * Block nodes serialize to their markdown line form: `# ` headings, `- ` /
 * `1. ` list items (children indented to the marker width), `> ` quote
 * prefixes on every line, and ``` fences sized past any backtick run in the
 * code text. Inline emphasis is handled by a mark stack within each line run.
 */
export function docToDraft(doc: PMNode): { value: string; mentions: MentionRecord[] } {
  let value = '';
  const mentions: MentionRecord[] = [];

  // Currently-open emphasis marks whose opening markers are already in `value`.
  const open: Array<{ type: string; openedAt: number }> = [];
  let lastMentionEnd = 0;
  let started = false;

  // Start a block-level line: newline separator (except for the very first
  // line of the document) followed by the line's prefix/marker.
  const newline = (lineStart: string) => {
    if (started) value += '\n';
    started = true;
    value += lineStart;
  };

  // Close open marks down to depth `keep`. Markdown closers must hug a
  // non-space char, so trailing whitespace written inside a span is expelled
  // past its closer (never reaching past the opener or into a mention's
  // text). A span left empty drops its opener instead of emitting `****`.
  const closeTo = (keep: number) => {
    let expelled = '';
    while (open.length > keep) {
      const top = open.pop()!;
      const ws = value.match(/[ \t]+$/);
      if (ws) {
        const cut = Math.max(top.openedAt, lastMentionEnd, value.length - ws[0].length);
        expelled = value.slice(cut) + expelled;
        value = value.slice(0, cut);
      }
      if (value.length === top.openedAt) {
        value = value.slice(0, top.openedAt - MARK_DELIM[top.type].length);
      } else {
        value += MARK_DELIM[top.type];
      }
    }
    value += expelled;
  };

  // Bring the open stack to `target` (sorted by MARK_ORDER). `lead` is the
  // upcoming text's leading whitespace, emitted before any new openers —
  // markdown openers must hug a non-space char.
  const transition = (target: string[], lead: string) => {
    let common = 0;
    while (common < open.length && common < target.length && open[common].type === target[common]) {
      common += 1;
    }
    closeTo(common);
    value += lead;
    for (let i = common; i < target.length; i += 1) {
      value += MARK_DELIM[target[i]];
      open.push({ type: target[i], openedAt: value.length });
    }
  };

  // Inline run of text / hardBreak / mention nodes. `breakPrefix` is what a
  // hardBreak's continuation line starts with (quote prefix, item indent).
  const serializeInline = (content: PMNode[] | undefined, breakPrefix: string) => {
    for (const inline of content ?? []) {
      if (inline.type === 'text') {
        let text = inline.text ?? '';
        if (hasCodeMark(inline)) {
          closeTo(0);
          value += codeSpan(text);
          continue;
        }
        const target = emphasisMarks(inline);
        let lead = '';
        if (target.length > 0) {
          const ws = text.match(/^[ \t]+/);
          if (ws) {
            lead = ws[0];
            text = text.slice(lead.length);
          }
        }
        transition(target, lead);
        value += text;
      } else if (inline.type === 'hardBreak') {
        closeTo(0);
        value += '\n' + breakPrefix;
      } else if (inline.type === MENTION) {
        transition(emphasisMarks(inline), '');
        const attrs = (inline.attrs ?? {}) as Partial<MentionAttrs>;
        const label = attrs.label ?? attrs.refId ?? '';
        const start = value.length;
        value += `@${label}`;
        mentions.push({
          start,
          end: value.length, // start + 1 ('@') + label.length
          kind: attrs.kind ?? 'context',
          refId: attrs.refId ?? label,
          label,
        });
        lastMentionEnd = value.length;
      }
      // Any other inline node type is ignored (the composer only emits the three
      // above) — guarantees value/offsets stay in sync with what we serialize.
    }
    closeTo(0);
  };

  // `firstPrefix` starts the node's first line; `restPrefix` starts every
  // following line (continuations, later quote paragraphs, fence body…).
  const serializeBlock = (node: PMNode, firstPrefix: string, restPrefix: string) => {
    switch (node.type) {
      case 'heading': {
        const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
        newline(firstPrefix + '#'.repeat(level) + ' ');
        serializeInline(node.content, restPrefix);
        break;
      }
      case 'codeBlock': {
        const text = (node.content ?? []).map((n) => n.text ?? '').join('');
        const fenceLen = Math.max(
          3,
          ...text.split('\n').map((l) => (l.match(/^`+/) ?? [''])[0].length + 1),
        );
        const fence = '`'.repeat(fenceLen);
        const lang = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
        newline(firstPrefix + fence + lang);
        for (const line of text.split('\n')) newline(restPrefix + line);
        newline(restPrefix + fence);
        break;
      }
      case 'blockquote': {
        (node.content ?? []).forEach((child, j) => {
          serializeBlock(child, (j === 0 ? firstPrefix : restPrefix) + '> ', restPrefix + '> ');
        });
        break;
      }
      case 'bulletList': {
        (node.content ?? []).forEach((item, i) => {
          serializeListItem(item, i === 0 ? firstPrefix : restPrefix, '- ');
        });
        break;
      }
      case 'orderedList': {
        const startAt = Number(node.attrs?.start ?? 1);
        (node.content ?? []).forEach((item, i) => {
          serializeListItem(item, i === 0 ? firstPrefix : restPrefix, `${startAt + i}. `);
        });
        break;
      }
      default: {
        // paragraph — and any unknown block degrades to its inline content.
        newline(firstPrefix);
        serializeInline(node.content, restPrefix);
      }
    }
  };

  // List item: the marker decorates the first line only; every other line of
  // the item (continuations, nested blocks) indents to the marker's width.
  const serializeListItem = (item: PMNode, linePrefix: string, marker: string) => {
    const children = item.content ?? [];
    const cont = linePrefix + ' '.repeat(marker.length);
    if (children.length === 0) {
      newline(linePrefix + marker);
      return;
    }
    children.forEach((child, j) => {
      serializeBlock(child, j === 0 ? linePrefix + marker : cont, cont);
    });
  };

  for (const block of doc.content ?? []) serializeBlock(block, '', '');

  return { value, mentions };
}

const textNode = (text: string, marks: string[]): PMNode =>
  marks.length ? { type: 'text', text, marks: marks.map((type) => ({ type })) } : { type: 'text', text };

// Find the closing backtick run of exactly `len` backticks (CommonMark: a code
// span closes on an equal-length run).
function findFenceClose(text: string, from: number, len: number): number {
  for (let j = from; j < text.length; j += 1) {
    if (text[j] !== '`') continue;
    const run = text.slice(j).match(/^`+/)![0].length;
    if (run === len) return j;
    j += run - 1;
  }
  return -1;
}

// First occurrence of `delim` after `from` that closes an emphasis span: the
// char before it must be non-space, and the span must be non-empty (j > from).
function findEmphasisClose(text: string, from: number, delim: string): number {
  let j = from;
  while ((j = text.indexOf(delim, j)) !== -1) {
    if (j > from && text[j - 1] !== ' ' && text[j - 1] !== '\t') return j;
    j += 1;
  }
  return -1;
}

const EMPHASIS: Array<[delim: string, mark: string]> = [
  ['**', 'bold'],
  ['~~', 'strike'],
  ['*', 'italic'],
];

// Parse one line of markdown (no newlines) into text nodes with marks.
// Deliberately CommonMark-lite: `**` `*` `~~` and backtick code spans, opener
// hugging a non-space char, closer preceded by one. Anything unmatched stays
// literal — the parser may only ever move characters between "literal text"
// and "marked text", never add or drop them, so `value` round-trips exactly.
function parseInline(text: string, marks: string[]): PMNode[] {
  const out: PMNode[] = [];
  let plain = '';
  let i = 0;
  const flush = () => {
    if (plain) {
      out.push(textNode(plain, marks));
      plain = '';
    }
  };

  while (i < text.length) {
    if (text[i] === '`') {
      const fence = text.slice(i).match(/^`+/)![0];
      const innerStart = i + fence.length;
      const close = findFenceClose(text, innerStart, fence.length);
      if (close > innerStart) {
        let inner = text.slice(innerStart, close);
        // Undo the serializer's edge-backtick padding — only that exact case,
        // so a hand-typed padded span like ` x ` stays verbatim (wire-stable).
        if (inner.startsWith(' ') && inner.endsWith(' ') && inner.length > 2) {
          const trimmed = inner.slice(1, -1);
          if (trimmed.startsWith('`') || trimmed.endsWith('`')) inner = trimmed;
        }
        flush();
        out.push(textNode(inner, [...marks, 'code']));
        i = close + fence.length;
        continue;
      }
    } else {
      let matched = false;
      for (const [delim, mark] of EMPHASIS) {
        if (marks.includes(mark) || !text.startsWith(delim, i)) continue;
        const innerStart = i + delim.length;
        const after = text[innerStart];
        if (!after || after === ' ' || after === '\t') continue;
        // A lone `*` followed by `*` is the tail of a failed `**` — literal.
        if (mark === 'italic' && after === '*') continue;
        const close = findEmphasisClose(text, innerStart, delim);
        if (close === -1) continue;
        flush();
        out.push(...parseInline(text.slice(innerStart, close), [...marks, mark]));
        i = close + delim.length;
        matched = true;
        break;
      }
      if (matched) continue;
    }
    plain += text[i];
    i += 1;
  }
  flush();
  return out;
}

/**
 * Inverse of `docToDraft`: build a doc from the controlled `{ value, mentions }`
 * form. Used to seed / re-sync the editor from external draft state (restore,
 * queue branch, history redo).
 *
 * Line-based block parsing, deliberately limited to the exact forms the
 * serializer emits (`# `…`###### `, `- `, `1. `, `> `, closed ``` fences) —
 * anything else stays a literal paragraph line, so `value` always round-trips
 * exactly. Consecutive plain lines collapse into one paragraph joined by
 * hardBreaks (the pre-block-support canonical shape).
 *
 * Mentions are assumed non-overlapping; they're sorted defensively. The slice
 * of `value` covered by each mention (`@label`) is dropped in favour of an
 * atomic mention node. A mention overlapping a would-be block prefix or a
 * fence region demotes that construct to literal text so the mention node
 * always survives.
 */
export function draftToDoc(value: string, mentions: MentionRecord[]): PMNode {
  const sorted = [...mentions].sort((a, b) => a.start - b.start);

  // Lines with their absolute offsets into `value` (mention ranges are
  // absolute, so every slice below works in absolute coordinates).
  interface Line {
    start: number;
    text: string;
  }
  const lines: Line[] = [];
  let pos = 0;
  for (const part of value.split('\n')) {
    lines.push({ start: pos, text: part });
    pos += part.length + 1;
  }

  // True when a mention overlaps [absStart, absEnd) — used to guard block
  // prefixes and fence regions.
  const mentionOverlaps = (absStart: number, absEnd: number): boolean =>
    sorted.some((m) => m.end > absStart && m.start < absEnd);

  // Inline content for the absolute range [absStart, absEnd) of one line:
  // mention nodes for contained mention ranges, markdown-parsed text between.
  const inlineRange = (absStart: number, absEnd: number): PMNode[] => {
    const out: PMNode[] = [];
    let cur = absStart;
    for (const m of sorted) {
      if (m.start < cur || m.end > absEnd) continue;
      if (m.start > cur) out.push(...parseInline(value.slice(cur, m.start), []));
      const attrs: MentionAttrs = { refId: m.refId, label: m.label, kind: m.kind };
      out.push({ type: MENTION, attrs: attrs as unknown as Record<string, unknown> });
      cur = m.end;
    }
    if (cur < absEnd) out.push(...parseInline(value.slice(cur, absEnd), []));
    return out;
  };

  // List item marker at an exact indent depth. Only the serializer's own
  // forms count ("- ", "<n>. "); a star bullet or missing space stays literal.
  const itemMarker = (
    text: string,
    indent: number,
  ): { marker: string; num?: number; content: string } | null => {
    if (!text.startsWith(' '.repeat(indent))) return null;
    const rest = text.slice(indent);
    if (rest.startsWith('- ')) return { marker: '- ', content: rest.slice(2) };
    const m = rest.match(/^(\d+)\. (.*)$/);
    if (m) return { marker: `${m[1]}. `, num: Number(m[1]), content: m[2] };
    return null;
  };

  // Parse a run of list lines starting at ls[i] with markers at `indent`.
  // Ordered lists only swallow sequential numbers; a jump starts a new block.
  const tryParseList = (
    ls: Line[],
    at: number,
    indent: number,
  ): { node: PMNode; next: number } | null => {
    const first = itemMarker(ls[at].text, indent);
    if (!first) return null;
    const isOrdered = first.num !== undefined;
    const items: PMNode[] = [];
    let expect = first.num ?? 0;
    let j = at;
    while (j < ls.length) {
      const mk = itemMarker(ls[j].text, indent);
      if (!mk) break;
      if ((mk.num !== undefined) !== isOrdered) break;
      if (isOrdered && mk.num !== expect && items.length > 0) break;
      const line = ls[j];
      const contentStart = line.start + indent + mk.marker.length;
      if (mentionOverlaps(line.start, contentStart)) break;

      const contIndent = indent + mk.marker.length;
      const para = inlineRange(contentStart, line.start + line.text.length);
      let nested: PMNode | null = null;
      j += 1;
      while (j < ls.length) {
        const sub = tryParseList(ls, j, contIndent);
        if (sub) {
          nested = sub.node;
          j = sub.next;
          break; // nested list closes the item (multi-para items unsupported)
        }
        const lt = ls[j];
        const isContinuation =
          lt.text.length > contIndent &&
          lt.text.startsWith(' '.repeat(contIndent)) &&
          !mentionOverlaps(lt.start, lt.start + contIndent);
        if (!isContinuation) break;
        para.push({ type: 'hardBreak' }, ...inlineRange(lt.start + contIndent, lt.start + lt.text.length));
        j += 1;
      }

      const children: PMNode[] = [{ type: 'paragraph', content: para }];
      if (nested) children.push(nested);
      items.push({ type: 'listItem', content: children });
      if (isOrdered) expect = (mk.num ?? 0) + 1;
    }
    if (items.length === 0) return null;
    const node: PMNode = isOrdered
      ? { type: 'orderedList', attrs: { start: first.num }, content: items }
      : { type: 'bulletList', content: items };
    return { node, next: j };
  };

  // Closing line of a fence: exactly the same backtick run, nothing else.
  const findFenceClose = (ls: Line[], from: number, fence: string): number => {
    for (let k = from; k < ls.length; k += 1) {
      if (ls[k].text === fence) return k;
    }
    return -1;
  };

  const parseBlocks = (ls: Line[]): PMNode[] => {
    const blocks: PMNode[] = [];
    let para: PMNode[] | null = null;
    const flushPara = () => {
      if (para) {
        blocks.push({ type: 'paragraph', content: para });
        para = null;
      }
    };

    let i = 0;
    while (i < ls.length) {
      const line = ls[i];
      const lineEnd = line.start + line.text.length;

      const fenceMatch = line.text.match(/^(`{3,})(\S*)$/);
      if (fenceMatch) {
        const close = findFenceClose(ls, i + 1, fenceMatch[1]);
        if (close !== -1 && !mentionOverlaps(line.start, ls[close].start + ls[close].text.length)) {
          flushPara();
          const text = ls
            .slice(i + 1, close)
            .map((l) => l.text)
            .join('\n');
          blocks.push({
            type: 'codeBlock',
            attrs: { language: fenceMatch[2] || null },
            content: text ? [{ type: 'text', text }] : [],
          });
          i = close + 1;
          continue;
        }
      }

      const headingMatch = line.text.match(/^(#{1,6}) /);
      if (headingMatch && !mentionOverlaps(line.start, line.start + headingMatch[0].length)) {
        flushPara();
        blocks.push({
          type: 'heading',
          attrs: { level: headingMatch[1].length },
          content: inlineRange(line.start + headingMatch[0].length, lineEnd),
        });
        i += 1;
        continue;
      }

      if (line.text.startsWith('> ') && !mentionOverlaps(line.start, line.start + 2)) {
        flushPara();
        const inner: Line[] = [];
        while (
          i < ls.length &&
          ls[i].text.startsWith('> ') &&
          !mentionOverlaps(ls[i].start, ls[i].start + 2)
        ) {
          inner.push({ start: ls[i].start + 2, text: ls[i].text.slice(2) });
          i += 1;
        }
        blocks.push({ type: 'blockquote', content: parseBlocks(inner) });
        continue;
      }

      const list = tryParseList(ls, i, 0);
      if (list) {
        flushPara();
        blocks.push(list.node);
        i = list.next;
        continue;
      }

      // Plain line: join into the open paragraph with a hardBreak.
      const content = inlineRange(line.start, lineEnd);
      if (para) {
        para.push({ type: 'hardBreak' }, ...content);
      } else {
        para = content;
      }
      i += 1;
    }
    flushPara();
    return blocks;
  };

  return { type: 'doc', content: parseBlocks(lines) };
}
