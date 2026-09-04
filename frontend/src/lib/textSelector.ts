/**
 * W3C Web Annotation-aligned text selector for precise sub-document anchoring.
 *
 * Combines TextQuoteSelector (exact + prefix + suffix for disambiguation and
 * edit-resilient matching) with TextPositionSelector (character offsets for
 * fast direct access) and Michi-specific extensions (line numbers for agent
 * `read()` calls, markdown heading anchors for human readability).
 *
 * @see https://www.w3.org/TR/annotation-model/#text-quote-selector
 * @see https://www.w3.org/TR/annotation-model/#text-position-selector
 */

/**
 * Structured selector describing a precise text region within a document.
 * All fields except `exact` are optional — callers provide what they can.
 */
export interface TextSelector {
  // --- W3C TextQuoteSelector (core) ---
  /** The full selected text, NOT truncated. */
  exact: string;
  /** Characters immediately before the selection, for disambiguation. */
  prefix?: string;
  /** Characters immediately after the selection, for disambiguation. */
  suffix?: string;

  // --- W3C TextPositionSelector (auxiliary) ---
  /** 0-based character offset from the start of the document text. */
  startOffset?: number;
  /** 0-based character offset of the end of the selection. */
  endOffset?: number;

  // --- Michi extensions (agent-friendly shortcuts) ---
  /** 1-based line number of the first selected line. */
  startLine?: number;
  /** 1-based line number of the last selected line. */
  endLine?: number;
  /** Nearest ancestor markdown heading path, e.g. "## Config > ### domainOwner". */
  section?: string;
}

/** How many context characters to capture before/after the selection. */
const CONTEXT_CHARS = 50;

/**
 * Compute a W3C-aligned TextSelector from a plaintext document and a
 * known substring region defined by character offsets.
 *
 * This is the pure-logic core that doesn't touch the DOM — call it from
 * any context where you already know the document text and the region.
 */
export function computeTextSelector(
  documentText: string,
  startOffset: number,
  endOffset: number,
): TextSelector {
  const exact = documentText.slice(startOffset, endOffset);

  // prefix / suffix — up to CONTEXT_CHARS, stopping at document boundaries.
  const prefixStart = Math.max(0, startOffset - CONTEXT_CHARS);
  const prefix = documentText.slice(prefixStart, startOffset);

  const suffixEnd = Math.min(documentText.length, endOffset + CONTEXT_CHARS);
  const suffix = documentText.slice(endOffset, suffixEnd);

  // Line numbers — 1-based, counting newlines before the offset.
  const startLine = documentText.slice(0, startOffset).split('\n').length;
  const endLine = documentText.slice(0, endOffset).split('\n').length;

  // Section — walk backwards from startOffset looking for the nearest
  // markdown heading (lines starting with #).
  const section = findNearestHeadingPath(documentText, startOffset);

  return {
    exact,
    prefix: prefix || undefined,
    suffix: suffix || undefined,
    startOffset,
    endOffset,
    startLine,
    endLine,
    section: section || undefined,
  };
}

/**
 * Walk backwards from `offset` through the document text, collecting
 * the nearest markdown heading ancestry into a ">" separated path.
 *
 * For example, if the text before the offset contains:
 *   # Top Level
 *   ## Configuration Fields
 *   ### domainOwner
 *
 * The result is "# Top Level > ## Configuration Fields > ### domainOwner".
 *
 * Returns an empty string if no headings are found before the offset.
 */
export function findNearestHeadingPath(
  documentText: string,
  offset: number,
): string {
  // Get all text before the offset, split into lines.
  const textBefore = documentText.slice(0, offset);
  const lines = textBefore.split('\n');

  // Walk backwards collecting headings, one per level.
  // headings[1] = nearest # heading, headings[2] = nearest ## heading, etc.
  const headings: Map<number, string> = new Map();
  let currentLevel = Infinity;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      const level = match[1].length;
      // Only keep the heading if we haven't seen this level or a higher one yet
      // (walking backwards, first hit at each level is the most relevant).
      if (!headings.has(level) && level <= currentLevel) {
        headings.set(level, line.trim());
        currentLevel = level;
        // If we've found a level-1 heading, we have the full ancestry.
        if (level === 1) break;
      }
    }
  }

  if (headings.size === 0) return '';

  // Sort by level and join into a path.
  return Array.from(headings.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, heading]) => heading)
    .join(' > ');
}

/**
 * Find the character offset of a selected text within a document,
 * given the exact text and optional prefix/suffix for disambiguation.
 *
 * This is the "anchoring" step — given a selector, find where it
 * matches in a (possibly edited) document. Tries exact match first,
 * then falls back to prefix+suffix guided search.
 *
 * Returns the startOffset of the match, or -1 if not found.
 */
export function anchorSelector(
  documentText: string,
  selector: Pick<TextSelector, 'exact' | 'prefix' | 'suffix' | 'startOffset'>,
): number {
  const { exact, prefix, suffix, startOffset } = selector;

  // Fast path: try the recorded offset first — if the text there still
  // matches the exact string, we're done.
  if (
    startOffset !== undefined &&
    startOffset >= 0 &&
    documentText.slice(startOffset, startOffset + exact.length) === exact
  ) {
    return startOffset;
  }

  // Fallback: find all occurrences of the exact text.
  const candidates: number[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = documentText.indexOf(exact, searchFrom);
    if (idx === -1) break;
    candidates.push(idx);
    searchFrom = idx + 1;
  }

  if (candidates.length === 0) return -1;
  if (candidates.length === 1) return candidates[0];

  // Multiple matches — use prefix/suffix to disambiguate.
  if (prefix || suffix) {
    let bestIdx = candidates[0];
    let bestScore = -1;

    for (const idx of candidates) {
      let score = 0;
      if (prefix) {
        const docPrefix = documentText.slice(Math.max(0, idx - prefix.length), idx);
        // Score by how many trailing characters match.
        for (let i = 1; i <= Math.min(prefix.length, docPrefix.length); i++) {
          if (prefix[prefix.length - i] === docPrefix[docPrefix.length - i]) {
            score++;
          } else {
            break;
          }
        }
      }
      if (suffix) {
        const docSuffix = documentText.slice(idx + exact.length, idx + exact.length + suffix.length);
        // Score by how many leading characters match.
        for (let i = 0; i < Math.min(suffix.length, docSuffix.length); i++) {
          if (suffix[i] === docSuffix[i]) {
            score++;
          } else {
            break;
          }
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    }

    return bestIdx;
  }

  // No prefix/suffix — return the first match.
  return candidates[0];
}

/**
 * Given a DOM Range and the full plaintext of the document rendered
 * in the container, compute the character offsets of the selection.
 *
 * This uses a TreeWalker to count text node characters up to the
 * Range's start/end boundaries, producing offsets into `documentText`.
 *
 * Returns null if the range cannot be mapped (e.g. container mismatch).
 */
export function rangeToOffsets(
  range: Range,
  container: HTMLElement,
  documentText: string,
): { startOffset: number; endOffset: number } | null {
  // Use the range's toString() as the canonical selected text.
  const selectedText = range.toString();
  if (!selectedText.trim()) return null;

  // Strategy: find the selected text in the document text, using the
  // DOM position as a hint for disambiguation.
  //
  // We walk text nodes to estimate a character position, then search
  // near that position for the exact text.
  const estimatedStart = estimateTextOffset(
    container,
    range.startContainer,
    range.startOffset,
  );

  if (estimatedStart < 0) {
    // Fallback: just find the first occurrence.
    const idx = documentText.indexOf(selectedText);
    return idx >= 0 ? { startOffset: idx, endOffset: idx + selectedText.length } : null;
  }

  // Search in a window around the estimated position.
  const searchRadius = 500;
  const searchStart = Math.max(0, estimatedStart - searchRadius);
  const searchEnd = Math.min(documentText.length, estimatedStart + selectedText.length + searchRadius);
  const window = documentText.slice(searchStart, searchEnd);
  const localIdx = window.indexOf(selectedText);
  if (localIdx >= 0) {
    const startOffset = searchStart + localIdx;
    return { startOffset, endOffset: startOffset + selectedText.length };
  }

  // Wider fallback.
  const globalIdx = documentText.indexOf(selectedText);
  return globalIdx >= 0
    ? { startOffset: globalIdx, endOffset: globalIdx + selectedText.length }
    : null;
}

/**
 * Walk text nodes inside `container` up to the given DOM position,
 * counting characters to produce an estimated offset into the container's
 * aggregate text content.
 *
 * Returns -1 if the target node is not inside the container.
 */
function estimateTextOffset(
  container: HTMLElement,
  targetNode: Node,
  targetOffset: number,
): number {
  if (!container.contains(targetNode)) return -1;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let charCount = 0;

  while (walker.nextNode()) {
    const textNode = walker.currentNode as Text;
    if (textNode === targetNode) {
      return charCount + targetOffset;
    }
    charCount += textNode.textContent?.length ?? 0;
  }

  // targetNode might be an Element — find the first text node child at offset.
  if (targetNode.nodeType === Node.ELEMENT_NODE) {
    const childNodes = targetNode.childNodes;
    let count = 0;
    const walker2 = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    while (walker2.nextNode()) {
      const textNode = walker2.currentNode as Text;
      // Check if this text node is before or at the target position.
      let isAfterTarget = false;
      for (let i = 0; i < childNodes.length && i < targetOffset; i++) {
        if (childNodes[i].contains(textNode)) {
          isAfterTarget = false;
          break;
        }
      }
      if (isAfterTarget) return count;
      count += textNode.textContent?.length ?? 0;
    }
    return charCount; // best effort
  }

  return -1;
}
