// Markdown segments addressed by page edits as `<block>~<n>`.
// Keep numbering deterministic so edits reach the intended paragraph.

export type MdSegmentKind = 'heading' | 'paragraph' | 'list-item' | 'code' | 'table' | 'quote';

/** One heading, paragraph, list item, code block, table or quote; `text` is its source lines, unchanged. */
export interface MdSegment {
  index: number;
  kind: MdSegmentKind;
  text: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}#{1,6}(\s|$)/;
const ITEM = /^ {0,3}([-*+]|\d+[.)])\s/;
const TABLE = /^ {0,3}\|/;
const QUOTE = /^ {0,3}>/;

/** The fence a line opens, or null. A backtick fence whose info string holds a backtick is inline code, not a fence. */
function opens(line: string): string | null {
  const m = FENCE.exec(line);
  return m && !(m[1][0] === '`' && m[2].includes('`')) ? m[1] : null;
}

/**
 * One past the line that closes `fence`; an unclosed fence runs to the end.
 * The closer may be longer and is matched at any indent, because one inside
 * a list item is indented.
 */
function fenceEnd(lines: readonly string[], from: number, fence: string): number {
  for (let j = from + 1; j < lines.length; j += 1) {
    const t = lines[j].trim();
    if (t.length >= fence.length && t === fence[0].repeat(t.length)) return j + 1;
  }
  return lines.length;
}

function lead(line: string): number {
  let n = 0;
  for (const c of line) {
    if (c === ' ') n += 1;
    else if (c === '\t') n += 4;
    else break;
  }
  return n;
}

/** An item owns the lines after it that are indented 2 more than it is, and the blank lines between them. */
function itemEnd(lines: readonly string[], from: number): number {
  const need = lead(lines[from]) + 2;
  let end = from + 1;
  for (let j = from + 1; j < lines.length; j += 1) {
    if (!lines[j].trim()) continue;
    if (lead(lines[j]) < need) break;
    const fence = opens(lines[j].trimStart());
    if (fence) j = fenceEnd(lines, j, fence) - 1;
    end = j + 1;
  }
  return end;
}

/** Lines that begin a block of their own, so they end a paragraph even without a blank line before them. */
function starts(line: string): boolean {
  return opens(line) !== null || HEADING.test(line) || ITEM.test(line) || TABLE.test(line) || QUOTE.test(line);
}

export function splitMarkdown(text: string): MdSegment[] {
  const lines = text.split(/\r?\n/);
  const out: MdSegment[] = [];
  const push = (kind: MdSegmentKind, from: number, to: number) => {
    let end = to;
    while (end > from && !lines[end - 1].trim()) end -= 1;
    out.push({ index: out.length, kind, text: lines.slice(from, end).join('\n') });
  };
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = opens(line);
    if (fence) {
      const end = fenceEnd(lines, i, fence);
      push('code', i, end);
      i = end;
      continue;
    }
    if (HEADING.test(line)) {
      push('heading', i, i + 1);
      i += 1;
      continue;
    }
    if (ITEM.test(line)) {
      const end = itemEnd(lines, i);
      push('list-item', i, end);
      i = end;
      continue;
    }
    const run = TABLE.test(line) ? TABLE : QUOTE.test(line) ? QUOTE : null;
    if (run) {
      let j = i + 1;
      while (j < lines.length && run.test(lines[j])) j += 1;
      push(run === TABLE ? 'table' : 'quote', i, j);
      i = j;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && lines[j].trim() && !starts(lines[j])) j += 1;
    push('paragraph', i, j);
    i = j;
  }
  return out;
}

/** Segments are joined by a blank line, so a tight list comes back loose; splitting the result gives the same segments. */
export const joinMarkdown = (segments: readonly string[]) => segments.join('\n\n');

/** `~` is outside the characters a block id may hold, so a plain block id never parses as a segment id. */
export const segmentId = (blockId: string, index: number) => `${blockId}~${index}`;

export function parseSegmentId(id: string): { blockId: string; index: number } | null {
  const at = id.lastIndexOf('~');
  const tail = id.slice(at + 1);
  // No leading zeros and at most 9 digits: one spelling per segment, and always a safe integer.
  return at > 0 && /^(0|[1-9]\d{0,8})$/.test(tail) ? { blockId: id.slice(0, at), index: Number(tail) } : null;
}
