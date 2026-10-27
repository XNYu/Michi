// Michi's one-line summaries (where a thread stopped, what is next) are often
// copied from an agent's Markdown answer. On a row, card or menu line they
// read as plain words: Markdown's syntax goes, what it marked up stays.

const LINE_PREFIXES: RegExp[] = [
  /^[ \t]{0,3}#{1,6}[ \t]+/gm, // headings
  /^[ \t]{0,3}(?:>[ \t]?)+/gm, // block quotes, nested too
  /^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, // list items and task boxes
];

/** A table row `| a | b |` as `a · b`; its `|---|---|` rule goes. */
function tableRows(text: string): string {
  return text
    .replace(/^[ \t]*\|?(?:[ \t]*:?-{3,}:?[ \t]*\|)+(?:[ \t]*:?-{3,}:?[ \t]*)?\|?[ \t]*$/gm, '')
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, cells: string) => cells.split('|').map((c) => c.trim()).filter(Boolean).join(' · '));
}

// Code is held out of the passes below as a placeholder and put back
// verbatim at the end, so `__init__.py`, `[x](y)` and `a**2` survive.
const HELD = /\uE000(\d+)\uE001/g;
// A fence, perhaps inside a block quote: its quote marks, its fence, the rest.
const FENCE = /^([ \t]*(?:>[ \t]?)*)[ \t]*(`{3,}|~{3,})(.*)$/;
// An inline code span; it never reaches into a held block (the placeholder's marks).
const INLINE_CODE = /(`+)(?!`)([^\uE000\uE001]*?[^`\uE000\uE001])\1(?!`)/g;
const quoteDepth = (marks: string) => (marks.match(/>/g) ?? []).length;
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * How many spans read inside out when backtick runs are paired from run
 * `from` on, each with the next run of its length: spans whose code starts
 * or ends with a space, as the words between two real spans do.
 */
function insideOutSpans(text: string, runs: RegExpMatchArray[], from: number): number {
  let count = 0;
  for (let i = from; i < runs.length; i += 1) {
    const open = runs[i];
    const j = runs.findIndex((run, k) => k > i && run[0].length === open[0].length);
    if (j === -1) continue;
    const code = text.slice((open.index ?? 0) + open[0].length, runs[j].index ?? 0);
    if (/^\s|\s$/.test(code)) count += 1;
    i = j;
  }
  return count;
}

/**
 * Where text that starts inside a code span (Michi cut the message a little
 * before a match, mid-span) is back out of it: just past the backtick run
 * that closes it, else 0. That run is shaped like a close (right after a
 * non-space, before a space, punctuation or the end), and pairing the runs
 * after it leaves fewer spans inside out than pairing from it, the way a
 * reader would see it. Counting runs can't tell: Michi may cut the end
 * mid-span too. `text` holds no fenced block (held, or blanked, by the caller).
 */
export function michiLeadingCodeEnd(text: string): number {
  const runs = [...text.matchAll(/`+/g)];
  if (runs.length === 0) return 0;
  const at = runs[0].index ?? 0;
  const end = at + runs[0][0].length;
  const before = text[at - 1];
  const after = text[end];
  const closes = at > 0 && !/\s/.test(before) && (after === undefined || !WORD_CHAR.test(after));
  if (!closes) return 0;
  return insideOutSpans(text, runs, 1) < insideOutSpans(text, runs, 0) ? end : 0;
}

/** `text` with fenced blocks and inline code spans swapped for placeholders into `held`. */
function holdCode(text: string, held: string[]): string {
  const hold = (code: string) => `\uE000${held.push(code) - 1}\uE001`;
  const lines: string[] = [];
  let fence: { mark: string; depth: number; marks: string } | null = null;
  let body: string[] = [];
  for (const line of text.split('\n')) {
    const found = FENCE.exec(line);
    if (fence === null) {
      if (found) {
        fence = { mark: found[2], depth: quoteDepth(found[1]), marks: found[1] };
        body = [];
      } else lines.push(line);
      continue;
    }
    const closes = found && found[2][0] === fence.mark[0] && found[2].length >= fence.mark.length
      && found[3].trim() === '' && quoteDepth(found[1]) === fence.depth;
    if (closes) {
      lines.push(fence.marks + hold(body.join('\n')));
      fence = null;
    } else {
      // Inside a quoted block, each line carries the quote's marks: they aren't code.
      body.push(fence.depth ? line.replace(new RegExp(`^[ \\t]*(?:>[ \\t]?){0,${fence.depth}}`), '') : line);
    }
  }
  if (fence !== null) lines.push(fence.marks + hold(body.join('\n'))); // a block the text ends inside
  let joined = lines.join('\n');
  // Cut open inside a span: everything up to its closing run is code.
  const resume = michiLeadingCodeEnd(joined);
  if (resume > 0) {
    const run = joined.slice(0, resume).match(/`+$/)![0];
    const rest = joined.slice(resume);
    joined = `${hold(joined.slice(0, resume - run.length).trim())}${WORD_CHAR.test(rest[0] ?? '') ? ' ' : ''}${rest}`;
  }
  // A span's own edge spaces still part it from the words around it.
  return joined.replace(INLINE_CODE, (_, _ticks: string, code: string) =>
    `${/^\s/.test(code) ? ' ' : ''}${hold(code.trim())}${/\s$/.test(code) ? ' ' : ''}`);
}

/**
 * Emphasis and code marks left over once every pair has been read. Michi cuts
 * a one-liner or an excerpt at its ends, so a cut explains only two of them:
 * the first leftover, if it closes (its opening was before the start), and
 * the last, if it opens (its closing was past the end, so the text doesn't end
 * like a finished sentence or expression). Those go. Every other leftover is
 * text: code written without backticks (a `src/**` glob, `func(**kwargs)`,
 * `int **pp;`), a mark inside a word (`a**b`) or standing alone (`2 ** 3`), an
 * escaped one. `__` always stays: alone it is a name (`__dirname`), not bold.
 *
 * A closing mark follows a word (code: anything but a space) and comes before
 * a space, punctuation or the end; at the very start, before a space, its
 * content was cut off. An opening mark comes after the start, a space or
 * punctuation (an emphasis mark: not an opening bracket or a slash) and
 * before a word (code: anything but a space); at the very end, after a space,
 * its content was cut off ("commit `").
 */
const LEFTOVER_MARK = /`+|\*\*|~~/g;
// An emphasis mark right after one of these is code: `func(**kwargs)`, `src/**`.
const CODE_BEFORE = /[([{</\\*~`]/;
// The text ends a sentence or an expression: nothing was cut at its end...
const FINISHED = /[.!?;)\]}。！？；）」』】]$/u;
// ...unless it says it was.
const CLIPPED = /(?:\.\.\.|…)$/u;

function dropCutMarks(text: string): string {
  const marks = [...text.matchAll(LEFTOVER_MARK)].filter((m) => text[(m.index ?? 0) - 1] !== '\\');
  if (marks.length === 0) return text;
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  const tail = text.slice(0, end);
  const finished = FINISHED.test(tail) && !CLIPPED.test(tail);
  const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);
  // What may sit right inside a mark: a word, or for code anything but a space.
  const inside = (mark: string, ch: string | undefined) =>
    ch !== undefined && (mark[0] === '`' ? !isSpace(ch) : WORD_CHAR.test(ch));
  const closes = (at: number, mark: string) => {
    const before = text[at - 1];
    const after = text[at + mark.length];
    if (at === start) return after === undefined || isSpace(after);
    return inside(mark, before) && (after === undefined || !WORD_CHAR.test(after));
  };
  const opens = (at: number, mark: string) => {
    const before = text[at - 1];
    const after = text[at + mark.length];
    if (at + mark.length === end) return before === undefined || isSpace(before);
    const afterText = before === undefined || isSpace(before)
      || (!WORD_CHAR.test(before) && (mark[0] === '`' || !CODE_BEFORE.test(before)));
    return afterText && inside(mark, after);
  };
  const first = marks[0];
  const last = marks[marks.length - 1];
  const drop = new Set<number>();
  if (closes(first.index ?? 0, first[0])) drop.add(first.index ?? 0);
  if (!finished && opens(last.index ?? 0, last[0])) drop.add(last.index ?? 0);
  let out = text;
  for (const m of [...marks].reverse()) {
    const at = m.index ?? 0;
    if (drop.has(at)) out = out.slice(0, at) + out.slice(at + m[0].length);
  }
  return out;
}

/**
 * `text` with every placeholder put back, including any held inside another.
 * A piece can only hold pieces held before it (`below`), so a placeholder-like
 * character pair in the text itself can't send this round in circles.
 */
function restoreCode(text: string, held: readonly string[], below = held.length): string {
  return text.replace(HELD, (whole: string, index: string) => {
    const at = Number(index);
    return at < below ? restoreCode(held[at], held, at) : whole;
  });
}

export interface MichiOneLineOptions {
  /**
   * Keep a link's or image's address after its text, as `text (address)`:
   * for a search hit whose only match is in the address.
   */
  linkUrls?: boolean;
}

/**
 * Markdown on one line as the words it says: no `#`, `>`, list markers,
 * fences, table pipes, `**`/`_`/`~~` emphasis or backticks; a link or image
 * becomes its text. Symbols that are just text (`C#`, `a > b`, `2*3*4`,
 * snake_case) stay as they are, and code keeps every character.
 */
export function michiOneLine(text: string, options: MichiOneLineOptions = {}): string {
  const held: string[] = [];
  // An address kept is held like code, so its `_` and `*` stay as written.
  const link = (_whole: string, label: string, url: string) => {
    if (!options.linkUrls || !url) return label;
    const address = `\uE000${held.push(url) - 1}\uE001`;
    return label.trim() && label.trim() !== url ? `${label} (${address})` : address;
  };
  let s = holdCode(text.replace(/\r\n?/g, '\n'), held);
  s = s.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, ''); // rules
  s = tableRows(s);
  for (const prefix of LINE_PREFIXES) s = s.replace(prefix, '');
  s = s
    .replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^()]*\))*)(?:\s+"[^"]*")?\)/g, link) // images
    .replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()]*\))*)(?:\s+"[^"]*")?\)/g, link) // links
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1') // autolinks
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1') // **bold**
    .replace(/(^|[^\p{L}\p{N}_])__(?=\S)([\s\S]*?\S)__(?![\p{L}\p{N}_])/gu, '$1$2') // __bold__, never inside a word
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1') // strikethrough
    .replace(/(^|[^\p{L}\p{N}*\\])\*(?=[^\s*])([^*\n]*?[^\s*\\])\*(?![\p{L}\p{N}*])/gu, '$1$2') // *em*
    .replace(/(^|[^\p{L}\p{N}_\\])_(?=[^\s_])([^_\n]*?[^\s_\\])_(?![\p{L}\p{N}_])/gu, '$1$2'); // _em_
  s = dropCutMarks(s).replace(/\\([\\`*_{}[\]()#+\-.!>|~])/g, '$1'); // escapes
  return restoreCode(s, held).replace(/\s+/g, ' ').trim();
}

/** Whether two one-liners say the same thing, ignoring case, spacing, Markdown and closing punctuation. */
export function michiSameText(a: string, b: string): boolean {
  const norm = (s: string) => michiOneLine(s).toLowerCase().replace(/[\s。.!！?？…:：;；,，]+$/u, '').replace(/\s+/g, ' ');
  const left = norm(a);
  return left !== '' && left === norm(b);
}
