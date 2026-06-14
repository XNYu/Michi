/**
 * Markdown slice-boundary helpers shared by the streaming reducer and terminal
 * renderer. A safe boundary is a place where a markdown document can be split
 * without leaving inline/block parser state open on either side.
 */

function findBoundary(text: string, offset: number): number | null {
  if (text.length === 0) return 0;

  const target = Math.max(0, Math.min(offset, text.length));

  let inFence = false;
  let fenceMarker: '```' | '~~~' | null = null;
  let bold = 0;
  let italicStar = 0;
  let italicUnder = 0;
  let codeSpan = 0;
  let linkOpen = false;

  let inListBlock = false;
  let listEnd = text.length;

  const safeAt = (i: number): boolean => {
    if (inFence) return false;
    if (bold !== 0 || italicStar !== 0 || italicUnder !== 0 || codeSpan !== 0) return false;
    if (linkOpen) return false;
    if (inListBlock && i < listEnd) return false;
    if (i === text.length) return true;
    return i >= 2 && text[i - 1] === '\n' && text[i - 2] === '\n';
  };

  const scanListEnd = (start: number): number => {
    let i = start;
    while (i < text.length) {
      let j = i;
      while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j += 1;
      const isItem =
        text[j] === '-' || text[j] === '*' || text[j] === '+' ||
        /^\d+\./.test(text.slice(j, j + 8));
      if (!isItem) return i;
      const nl = text.indexOf('\n', j);
      if (nl < 0) return text.length;
      if (text[nl + 1] === '\n') return nl + 2;
      i = nl + 1;
    }
    return text.length;
  };

  let i = 0;
  while (i < text.length) {
    if (i === 0 || text[i - 1] === '\n') {
      if (!inFence && !inListBlock) {
        let j = i;
        while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j += 1;
        const isItem =
          text[j] === '-' || text[j] === '*' || text[j] === '+' ||
          /^\d+\./.test(text.slice(j, j + 8));
        if (isItem) {
          inListBlock = true;
          listEnd = scanListEnd(i);
        }
      }
      if (inListBlock && i >= listEnd) {
        inListBlock = false;
      }
    }

    if (!inFence && text[i] === '\\') {
      if (i >= target && safeAt(i)) return i;
      i += 2;
      continue;
    }

    const tri = text.slice(i, i + 3);
    if (tri === '```' || tri === '~~~') {
      const isLineStart = i === 0 || text[i - 1] === '\n';
      if (isLineStart) {
        if (!inFence) {
          inFence = true;
          fenceMarker = tri as '```' | '~~~';
        } else if (tri === fenceMarker) {
          inFence = false;
          fenceMarker = null;
        }
        i += 3;
        continue;
      }
    }

    if (inFence) {
      i += 1;
      continue;
    }

    if (text.slice(i, i + 2) === '**') {
      bold ^= 1;
      i += 2;
      continue;
    }
    const c = text[i];
    if (c === '*') {
      italicStar ^= 1;
      i += 1;
      continue;
    }
    if (c === '_') {
      italicUnder ^= 1;
      i += 1;
      continue;
    }
    if (c === '`') {
      codeSpan ^= 1;
      i += 1;
      continue;
    }
    if (c === '[' && !linkOpen) {
      linkOpen = true;
      i += 1;
      continue;
    }
    if (linkOpen && c === ']' && text[i + 1] === '(') {
      let j = i + 2;
      let depth = 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '(') depth += 1;
        else if (text[j] === ')') depth -= 1;
        j += 1;
      }
      linkOpen = false;
      i = j;
      continue;
    }

    if (i >= target && safeAt(i)) return i;
    i += 1;
  }

  return target <= text.length && safeAt(text.length) ? text.length : null;
}

export function findNextSafeBoundaryOrNull(text: string, offset: number): number | null {
  return findBoundary(text, offset);
}

export function isSafeMarkdownBoundary(text: string, offset: number): boolean {
  return findBoundary(text, offset) === Math.max(0, Math.min(offset, text.length));
}

/**
 * Legacy offset snapper used by weaveToolCalls. It preserves the historical
 * behavior of falling back to text.length when no safe boundary exists yet.
 */
export function findNextSafeBoundary(text: string, offset: number): number {
  return findNextSafeBoundaryOrNull(text, offset) ?? text.length;
}
