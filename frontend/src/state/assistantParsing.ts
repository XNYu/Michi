const FOLLOWUP_MARKER = /(?:^|\n)[\s#*>_`-]*follow[-\s]?up\s+questions?\s*[:：][\s*_`]*/i;

/**
 * MeshClaw-style inline sentinel: `[FOLLOW-UPS: q1 | q2 | q3]` at the end of
 * the reply. Kept as a legacy fallback for replies generated before the
 * per-question format below.
 *
 * The `g` flag lets us take the LAST match — defensive against the LLM
 * quoting an earlier `[FOLLOW-UPS: ...]` tag mid-reply (rare, but matches
 * MeshClaw's `matches[-1]` strategy for their `[OPTIONS: ...]` equivalent).
 */
const INLINE_FOLLOW_UPS_RE = /\[FOLLOW-UPS:\s*([^\]]+)\]/gi;
// Closing `]` is preferred but optional — the LLM occasionally drops it (esp.
// when end-of-reply punctuation collides with the bracket). When missing,
// terminate on the next `[FOLLOW-UP` start, a newline, or end of input so the
// sentinel block still gets stripped from the visible reply.
const INLINE_FOLLOW_UP_RE = /\[FOLLOW-UP\s+([1-3])\s*(?:\/\s*3)?\s*:\s*([^\]\n\r]*?)(?:\]|(?=\s*\[FOLLOW-UP\s+[1-3])|(?=[\n\r])|$)/gi;
const SINGLE_INLINE_FOLLOW_UP_RE = /^\[FOLLOW-UP\s+([1-3])\s*(?:\/\s*3)?\s*:\s*([^\]]+)\]$/i;
const SINGLE_INLINE_FOLLOW_UPS_RE = /^\[FOLLOW-UPS:\s*([^\]]+)\]$/i;

export function parseInlineFollowUpSentinel(text: string): { index: number; followUp: string } | null {
  const match = text.match(SINGLE_INLINE_FOLLOW_UP_RE);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  const followUp = match[2].trim();
  if (!Number.isInteger(index) || index < 0 || index > 2 || !followUp) return null;
  return { index, followUp };
}

export function parseInlineFollowUpsSentinel(text: string): string[] {
  const match = text.match(SINGLE_INLINE_FOLLOW_UPS_RE);
  if (!match) return [];
  return match[1]
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 3);
}

function parseFollowUps(fullText: string): { visible: string; followUps: string[] } {
  const match = fullText.match(FOLLOWUP_MARKER);
  if (!match || match.index === undefined) return { visible: fullText.trim(), followUps: [] };
  const visible = fullText.slice(0, match.index).trim();
  const tail = fullText.slice(match.index + match[0].length);
  const followUps = tail
    .split('\n')
    .map((l) =>
      l
        .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
        .replace(/^[\s>*_`#]+/, '')
        .replace(/[\s*_`]+$/, '')
        .trim(),
    )
    .filter((l) => l.length > 0 && /[?？]/.test(l))
    .slice(0, 3);
  return { visible, followUps };
}

/**
 * Locate the follow-ups cut region in `rest` (post-title-strip text).
 * Returns the list of follow-up strings and the [cutStart, cutEnd) range
 * in `rest` that should be removed to produce visible text.
 *
 * Order of preference:
 *   1. Inline `[FOLLOW-UP 1/3: ...]` sentinels — current streaming format.
 *   2. Inline `[FOLLOW-UPS: q1 | q2 | q3]` — legacy compact format.
 *   3. Prose `Follow-up Questions:\n1. ...` — legacy format (kept as fallback).
 *
 * If neither matches, returns zero-length cut at end-of-string.
 */
function findFollowUpsCut(rest: string): { followUps: string[]; cutStart: number; cutEnd: number } {
  INLINE_FOLLOW_UP_RE.lastIndex = 0;
  // Extract from capture groups directly so this path can tolerate sentinels
  // without a closing `]` (the streaming `parseInlineFollowUpSentinel` keeps
  // its stricter `]`-required form because the stream char-loop only triggers
  // when it sees `]`).
  const perQuestionMatches = [...rest.matchAll(INLINE_FOLLOW_UP_RE)].flatMap((match) => {
    if (match.index === undefined) return [];
    const index = Number(match[1]) - 1;
    const followUp = match[2].trim();
    if (!Number.isInteger(index) || index < 0 || index > 2 || !followUp) return [];
    return [{
      index,
      followUp,
      start: match.index,
      end: match.index + match[0].length,
    }];
  });
  if (perQuestionMatches.length > 0) {
    const tailGroup = [perQuestionMatches[perQuestionMatches.length - 1]];
    for (let i = perQuestionMatches.length - 2; i >= 0; i -= 1) {
      const prev = perQuestionMatches[i];
      const next = tailGroup[0];
      if (!/^\s*$/.test(rest.slice(prev.end, next.start))) break;
      tailGroup.unshift(prev);
    }
    const slots: string[] = [];
    for (const item of tailGroup) slots[item.index] = item.followUp;
    const followUps = slots.filter((s) => s && s.trim().length > 0).slice(0, 3);
    if (followUps.length > 0) {
      let end = tailGroup[tailGroup.length - 1].end;
      while (end < rest.length && /\s/.test(rest[end])) end++;
      return { followUps, cutStart: tailGroup[0].start, cutEnd: end };
    }
  }

  // INLINE_FOLLOW_UPS_RE has the `g` flag — reset lastIndex to be safe
  // against stateful reuse when this function is called repeatedly.
  INLINE_FOLLOW_UPS_RE.lastIndex = 0;
  const inlineMatches = [...rest.matchAll(INLINE_FOLLOW_UPS_RE)];
  if (inlineMatches.length > 0) {
    const last = inlineMatches[inlineMatches.length - 1];
    if (last.index !== undefined) {
      const items = last[1]
        .split('|')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .slice(0, 3);
      if (items.length > 0) {
        let end = last.index + last[0].length;
        // Absorb trailing whitespace/newlines into the strip region so the
        // visible text doesn't end with a dangling blank line.
        while (end < rest.length && /\s/.test(rest[end])) end++;
        return { followUps: items, cutStart: last.index, cutEnd: end };
      }
    }
  }
  // Fall back to the prose "Follow-up Questions:" marker. Matches legacy
  // replies and any MCP tool fallback path.
  const proseMatch = rest.match(FOLLOWUP_MARKER);
  if (proseMatch && proseMatch.index !== undefined) {
    const { followUps } = parseFollowUps(rest);
    // Legacy semantic: everything from the marker to end-of-text is stripped.
    return { followUps, cutStart: proseMatch.index, cutEnd: rest.length };
  }
  return { followUps: [], cutStart: rest.length, cutEnd: rest.length };
}

const INLINE_TITLE_RE = /\[TITLE:\s*([^\]]+)\]/i;
const TITLE_MARKER = /^\s*(?:#+\s*)?\**\s*title\s*[:：]\s*\**\s*(.+?)\s*\**\s*$/im;

// Global form of the sentinels — used by `stripInlineMetadataSentinels` as a
// belt-and-suspenders pass on any text that already escaped bracket-hold +
// finalizeAssistant (e.g. backend-persisted body, mid-stream chunks where the
// `[TITLE: ...]` got released before close, or hydrated legacy turns).
const INLINE_TITLE_RE_G = /\[TITLE:\s*[^\]]+\]/gi;
const INLINE_FOLLOWUP_BLOCK_RE_G = /\[FOLLOW-UPS:\s*[^\]]+\]/gi;
const INLINE_FOLLOWUP_ITEM_RE_G = /\[FOLLOW-UP\s+[1-3]\s*(?:\/\s*3)?\s*:\s*[^\]\n\r]*?(?:\]|(?=\s*\[FOLLOW-UP\s+[1-3])|(?=[\n\r])|$)/gi;

/**
 * Scrub `[TITLE: ...]` and `[FOLLOW-UPS: ...]` / `[FOLLOW-UP n/3: ...]`
 * sentinels from arbitrary text. Idempotent. Use on any text that bypassed
 * the streaming-time bracket-hold filter (loaded from backend, recovered
 * from a stuck buffer, etc.) so the user never sees the raw metadata tags.
 */
export function stripInlineMetadataSentinels(text: string): string {
  if (!text || (text.indexOf('[') < 0)) return text;
  return text
    .replace(INLINE_TITLE_RE_G, '')
    .replace(INLINE_FOLLOWUP_BLOCK_RE_G, '')
    .replace(INLINE_FOLLOWUP_ITEM_RE_G, '')
    // Collapse the blank line that the sentinel used to live on.
    .replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n');
}

/**
 * Locate the title in `text`, preferring the inline `[TITLE: ...]` sentinel
 * (current PREAMBLE format) over the legacy `Title:` prose marker (kept so
 * persisted assistant turns from older builds still render with their title).
 */
function findTitleMatch(text: string): { match: RegExpMatchArray; titleText: string } | null {
  const inline = text.match(INLINE_TITLE_RE);
  if (inline && inline.index !== undefined) {
    return { match: inline, titleText: inline[1].trim() };
  }
  const prose = text.match(TITLE_MARKER);
  if (prose && prose.index !== undefined) {
    return { match: prose, titleText: prose[1].trim() };
  }
  return null;
}

export function parseTitle(fullText: string): { title: string | null; rest: string } {
  const found = findTitleMatch(fullText);
  if (!found) return { title: null, rest: fullText };
  const { match, titleText } = found;
  const before = fullText.slice(0, match.index!);
  const after = fullText.slice(match.index! + match[0].length).replace(/^\n+/, '');
  return { title: titleText, rest: before + after };
}

/**
 * Parse the raw assistant buffer into the visible text + a title + follow-up
 * suggestions. Shared by every stream subscriber so fallback parsing behaves
 * identically for parent and agent-spawned child turns.
 *
 * Also returns `remapOffset` — a function that maps a character offset in the
 * raw buffer to the corresponding offset in `visibleText`. This is needed so
 * tool-call chips (whose `textOffset` was recorded against the raw stream)
 * stay at the correct position after title/follow-up stripping.
 */
export function finalizeAssistant(raw: string): {
  title: string | null;
  followUps: string[];
  visibleText: string;
  remapOffset: (rawOffset: number) => number;
} {
  // --- Step 1: strip title line ---
  const titleFound = findTitleMatch(raw);
  let titleRemoveStart = -1;
  let titleRemoveEnd = -1; // exclusive, including trailing newlines
  let titleText: string | null = null;
  if (titleFound) {
    const { match, titleText: t } = titleFound;
    titleRemoveStart = match.index!;
    titleRemoveEnd = match.index! + match[0].length;
    titleText = t;
    // parseTitle also strips leading newlines from the "after" portion
    while (titleRemoveEnd < raw.length && raw[titleRemoveEnd] === '\n') {
      titleRemoveEnd++;
    }
  }

  const rest =
    titleRemoveStart >= 0
      ? raw.slice(0, titleRemoveStart) + raw.slice(titleRemoveEnd)
      : raw;

  // --- Step 2: strip follow-up tail (per-question inline preferred, legacy fallbacks kept) ---
  const fu = findFollowUpsCut(rest);
  // Use the cut start as the visible end — mirrors legacy prose behavior where
  // everything from the marker onward is stripped. For inline tags the cut
  // range is small (just the sentinel + trailing whitespace), so this also
  // preserves any content after the tag if the LLM put text past the marker.
  // In practice both are at end-of-reply so it doesn't matter.
  const fuCutInRest = fu.cutStart;
  const visible = rest.slice(0, fuCutInRest).trim();

  const followUps = fu.followUps;
  const title = titleText;

  // --- Build remapOffset ---
  const titleGap = titleRemoveStart >= 0 ? titleRemoveEnd - titleRemoveStart : 0;
  const visibleLen = visible.length;

  function remapOffset(rawOff: number): number {
    // Map raw offset → rest offset (account for title removal)
    let restOff = rawOff;
    if (titleRemoveStart >= 0) {
      if (rawOff <= titleRemoveStart) {
        restOff = rawOff;
      } else if (rawOff < titleRemoveEnd) {
        // Inside the removed title — snap to the removal point
        restOff = titleRemoveStart;
      } else {
        restOff = rawOff - titleGap;
      }
    }
    // Clamp to the follow-up cut point (anything beyond is stripped)
    return Math.min(restOff, visibleLen);
  }

  return { title, followUps, visibleText: visible, remapOffset };
}

/**
 * Metadata-only counterpart to `finalizeAssistant`. Used by the reducer's
 * `done` case to lift `title` / `followUps` out of `m.text` (now raw, append-only)
 * without producing a visible projection — the `done` action no longer rewrites
 * `m.text`, so `visibleText` / `remapOffset` belong to render-time derivation
 * via `deriveVisibleMessage`.
 */
export function extractAssistantMetadata(raw: string): {
  title: string | null;
  followUps: string[];
} {
  const titleFound = findTitleMatch(raw);
  const title = titleFound ? titleFound.titleText : null;

  const rest = (() => {
    if (!titleFound) return raw;
    const start = titleFound.match.index!;
    let end = start + titleFound.match[0].length;
    while (end < raw.length && raw[end] === '\n') end++;
    return raw.slice(0, start) + raw.slice(end);
  })();

  const fu = findFollowUpsCut(rest);
  return { title, followUps: fu.followUps };
}

// ── Streaming-safe sentinel stripping ────────────────────────────────────
//
// `finalizeAssistant` is a turn-end parser: it `trim()`s and only strips
// sentinels once they're fully formed. During streaming a half-formed
// `[TITLE: abc` has to disappear from the visible text *immediately* — if
// we let it appear and then strip when `]` arrives, useSmooth's source
// shrinks and the cursor resets, which is exactly the "字消失" failure mode
// we're redesigning to eliminate.
//
// Contract:
//   - visibleText is monotonic: appending raw characters never shortens it.
//     Tail bytes that *could* still extend into a sentinel prefix are held
//     out of visibleText. Once they can't (e.g. `[n` — `n` ∉ next-char of
//     `[TITLE:` or `[FOLLOW-UP`), they release immediately.
//   - Plain prose `[note]` and markdown links `[a](b)` pass through unchanged.
//   - `remapOffset(rawOff)` maps a raw-buffer offset to the corresponding
//     visibleText offset (used by tool-call `textOffset`).
//
// Implementation: walk raw; maintain a `bracketHold` for the in-progress
// segment. Resolve at:
//   1. closing `]`            → if sentinel, drop entire `[...]` plus
//                                immediately-trailing whitespace; else release
//   2. prefix can't match     → release everything held so far
//   3. end of raw with no `]` → if `bracketHold` is still a sentinel-prefix
//                                candidate, hold (visible doesn't include);
//                                else release.
//
// Sentinel detection is shared with the streaming-time filter in
// chatStreamRunner.ts via `SENTINEL_PREFIXES` below.

const SENTINEL_PREFIXES = ['[TITLE:', '[FOLLOW-UP'] as const;

function couldStillBeSentinel(buf: string): boolean {
  const upper = buf.toUpperCase();
  return SENTINEL_PREFIXES.some(
    (p) => (upper.length <= p.length ? p.startsWith(upper) : upper.startsWith(p)),
  );
}

function isCompletedSentinel(buf: string): boolean {
  // Must end on `]` and start with one of our prefixes.
  if (!buf.endsWith(']')) return false;
  const upper = buf.toUpperCase();
  return SENTINEL_PREFIXES.some((p) => upper.startsWith(p));
}

export interface VisibleProjection {
  visibleText: string;
  /** Map a raw-buffer offset → visibleText offset. Stable for the given raw. */
  remapOffset: (rawOff: number) => number;
  /**
   * Unresolved sentinel-looking tail held out of visibleText. Block-first
   * answer runs pass this to the next answer run so `[TITLE:` split by a
   * thinking block can still resolve without rescanning the whole message.
   */
  pendingRawTail?: string;
}

/**
 * Streaming-safe sentinel stripping. Produces a visibleText that is monotonic
 * across raw extensions (appending characters never shortens visibleText) and
 * a `remapOffset` for tool-call positioning.
 */
export function stripSentinelsStreamingSafe(raw: string): VisibleProjection {
  // `cuts` records [rawStart, rawEnd) regions that are excluded from visibleText.
  // Used both for projection and for remapOffset.
  type Cut = { start: number; end: number };
  const cuts: Cut[] = [];

  let i = 0;
  let holdStart = -1; // index in raw where current bracketHold began, or -1
  while (i < raw.length) {
    const ch = raw[i];
    if (holdStart < 0 && ch !== '[') {
      i++;
      continue;
    }
    if (holdStart < 0 && ch === '[') {
      holdStart = i;
      i++;
      continue;
    }
    // We're inside a hold. Try to resolve.
    const buf = raw.slice(holdStart, i + 1);
    if (ch === ']') {
      if (isCompletedSentinel(buf)) {
        // Cut the sentinel + any whitespace immediately after (including
        // newlines), so the blank line the sentinel sat on collapses.
        let end = i + 1;
        while (end < raw.length && /\s/.test(raw[end])) end++;
        cuts.push({ start: holdStart, end });
        i = end;
      } else {
        // Not a sentinel — release the hold (i.e., it stays in visibleText).
        i++;
      }
      holdStart = -1;
      continue;
    }
    if (!couldStillBeSentinel(buf)) {
      // Hold prefix can no longer grow into a sentinel. Release everything
      // held (it stays in visibleText) and resume normal scan.
      holdStart = -1;
      i++;
      continue;
    }
    i++;
  }

  // If the loop ends while still inside a hold, leave that tail OUT of
  // visibleText (monotonic guarantee — once `]` arrives we'll see whether
  // it's a sentinel; until then the tail is unresolved). Add the tail as a
  // cut so visibleText omits it; remapOffset clamps offsets inside the tail
  // to its start.
  let pendingTail: Cut | null = null;
  if (holdStart >= 0) pendingTail = { start: holdStart, end: raw.length };

  // Build visibleText by skipping cut + pendingTail regions.
  const allCuts = pendingTail ? [...cuts, pendingTail] : cuts;
  let visibleText = '';
  let cursor = 0;
  for (const c of allCuts) {
    if (c.start > cursor) visibleText += raw.slice(cursor, c.start);
    cursor = c.end;
  }
  if (cursor < raw.length) visibleText += raw.slice(cursor);

  function remapOffset(rawOff: number): number {
    let removed = 0;
    let off = rawOff;
    for (const c of allCuts) {
      if (rawOff <= c.start) break;
      if (rawOff < c.end) {
        // Inside a cut region — snap to the start (i.e. the same point in
        // visibleText where the cut was elided).
        off = c.start;
        break;
      }
      removed += c.end - c.start;
    }
    return Math.max(0, Math.min(off - removed, visibleText.length));
  }

  return {
    visibleText,
    remapOffset,
    pendingRawTail: pendingTail ? raw.slice(pendingTail.start, pendingTail.end) : undefined,
  };
}

/**
 * Single-source projection helper: given a `ChatMessage` whose `text` field
 * is the raw stream buffer, return the user-visible string + offset remapper.
 * Every UI/export/search/digest/copy/mobile path that reads "what the user
 * should see" must go through this helper so sentinels never leak.
 */
export function deriveVisibleMessage(m: { text: string }): VisibleProjection {
  return stripSentinelsStreamingSafe(m.text);
}
