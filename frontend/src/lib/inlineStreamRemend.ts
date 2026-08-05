/**
 * Streaming inline-markdown state machine for the pending-tail renderer.
 *
 * Deliberately independent from markdownBoundary.ts: that scanner decides
 * whether tool-chip weaving may split source safely, while this one is a
 * display-oriented approximation for the short streaming tail. The semantic
 * snapshot remains ground truth and corrects approximation errors on its next
 * refresh. All output from this module is display-only.
 */

export type InlineMarker =
  | '**'
  | '__'
  | '*'
  | '_'
  | '~~'
  | '`'
  | '$'
  | '$$'
  | '\\('
  | '\\['
  | '['
  | '![';

export interface OpenDelimiter {
  marker: InlineMarker;
  /** Source offset of the opening marker's first character. */
  offset: number;
  /** At least one non-space character was rendered after the opener. */
  hasContent: boolean;
  /** Exact backtick-run length for CommonMark code spans. */
  runLength?: number;
}

export interface InlineStreamState {
  /** Open inline delimiters, innermost last. */
  stack: OpenDelimiter[];
  inFence: boolean;
  fenceMarker: '```' | '~~~' | null;
  /** Inside the `(destination` portion of a Markdown link. */
  inLinkDestination: boolean;
  linkDestinationDepth: number;
  /** Up to three leading spaces still permit a block prefix. */
  lineIndent: number;
  /** A leading-pipe GFM table row replaces later pipes with spacing. */
  inTableRow: boolean;
  /** Inside a confirmed `<scheme:...>` or `<user@example.com>` autolink. */
  inAutolink: boolean;
  atLineStart: boolean;
  /** Last consumed character; an empty string means document start. */
  prevChar: string;
}

export const INITIAL_INLINE_STATE: InlineStreamState = {
  stack: [],
  inFence: false,
  fenceMarker: null,
  inLinkDestination: false,
  linkDestinationDepth: 0,
  lineIndent: 0,
  inTableRow: false,
  inAutolink: false,
  atLineStart: true,
  prevChar: '',
};

export type InlineEvent =
  | { type: 'text'; text: string }
  | {
      type: 'marker';
      marker: InlineMarker;
      action: 'open' | 'close';
      runLength?: number;
    }
  | { type: 'fence'; action: 'open' | 'close' };

export interface InlineScanResult {
  state: InlineStreamState;
  events: InlineEvent[];
  /** Trailing characters whose meaning depends on future input. */
  carry: string;
}

function isSpace(character: string | undefined): boolean {
  return character === undefined || /\s/.test(character);
}

function isWordCharacter(character: string | undefined): boolean {
  return !!character && /[\p{L}\p{N}_]/u.test(character);
}

function isLinkLabel(marker: InlineMarker): boolean {
  return marker === '[' || marker === '![';
}

function isMathMarker(marker: InlineMarker): boolean {
  return marker === '$' || marker === '$$' || marker === '\\(' || marker === '\\[';
}

function delimiterSource(delimiter: OpenDelimiter): string {
  return delimiter.marker === '`'
    ? '`'.repeat(delimiter.runLength ?? 1)
    : delimiter.marker;
}

function delimiterCloser(delimiter: OpenDelimiter): string {
  if (delimiter.marker === '\\(') return '\\)';
  if (delimiter.marker === '\\[') return '\\]';
  if (isLinkLabel(delimiter.marker)) return '';
  return delimiterSource(delimiter);
}

function thematicLine(
  input: string,
  index: number,
): { markerEnd: number; newline: boolean } | null {
  const newlineAt = input.indexOf('\n', index);
  const markerEnd = newlineAt >= 0 ? newlineAt : input.length;
  const compact = input.slice(index, markerEnd).replace(/[ \t]/g, '');
  if (!compact) return null;
  const marker = compact[0];
  const minimum = marker === '=' ? 2 : 3;
  if (!['*', '-', '_', '='].includes(marker) || compact.length < minimum) return null;
  if (![...compact].every((character) => character === marker)) return null;
  return { markerEnd, newline: newlineAt >= 0 };
}

function taskPrefix(
  input: string,
  index: number,
  waitWhenEmpty = false,
): { display: '☐' | '☑' | '☐ ' | '☑ '; end: number } | 'incomplete' | null {
  const tail = input.slice(index);
  const match = tail.match(/^\[([ xX])\](?:[ \t]+|$)/);
  if (match) {
    return {
      display: match[1] === ' '
        ? (match[0].length === 3 ? '☐' : '☐ ')
        : (match[0].length === 3 ? '☑' : '☑ '),
      end: index + match[0].length,
    };
  }
  if (!tail && waitWhenEmpty) return 'incomplete';
  if (/^\[[ xX]?\]?$/.test(tail)) return 'incomplete';
  return null;
}

const escapablePunctuationPattern = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/;
const MAX_HTML_CARRY = 256;

function isInlineSyntaxCharacter(character: string, inTableRow: boolean): boolean {
  switch (character) {
    case '\n':
    case '<':
    case '!':
    case '[':
    case ']':
    case '(':
    case '\\':
    case '`':
    case '$':
    case '*':
    case '_':
    case '~':
      return true;
    case '|':
      return inTableRow;
    default:
      return false;
  }
}

export function scanInline(
  input: string,
  initial: InlineStreamState = INITIAL_INLINE_STATE,
): InlineScanResult {
  const stack: OpenDelimiter[] = initial.stack.map((delimiter) => ({ ...delimiter }));
  let inFence = initial.inFence;
  let fenceMarker = initial.fenceMarker;
  let inLinkDestination = initial.inLinkDestination;
  let linkDestinationDepth = initial.linkDestinationDepth;
  let lineIndent = initial.lineIndent;
  let inTableRow = initial.inTableRow;
  let inAutolink = initial.inAutolink;
  let atLineStart = initial.atLineStart;
  let prevChar = initial.prevChar;
  const events: InlineEvent[] = [];
  let carry = '';

  const pushText = (text: string, visible = true) => {
    if (!text) return;
    if (visible) {
      const last = events[events.length - 1];
      if (last?.type === 'text') last.text += text;
      else events.push({ type: 'text', text });
    }
    if (/\S/.test(text)) {
      for (const delimiter of stack) delimiter.hasContent = true;
    }
  };

  const toggle = (
    marker: InlineMarker,
    offset: number,
    canOpen: boolean,
    canClose: boolean,
    runLength?: number,
  ) => {
    const top = stack[stack.length - 1];
    const sameRun = marker !== '`' || top?.runLength === runLength;
    if (top?.marker === marker && sameRun && canClose) {
      stack.pop();
      events.push({ type: 'marker', marker, action: 'close', runLength });
      return;
    }
    if (canOpen) {
      stack.push({ marker, offset, hasContent: false, runLength });
      events.push({ type: 'marker', marker, action: 'open', runLength });
      return;
    }
    pushText(marker === '`' ? '`'.repeat(runLength ?? 1) : marker);
  };

  let index = 0;
  while (index < input.length) {
    const character = input[index];
    const top = stack[stack.length - 1];
    const inCodeSpan = top?.marker === '`';
    const inMath = !!top && isMathMarker(top.marker);

    if (character === '\n') {
      if (prevChar === '\n') {
        for (let stackIndex = stack.length - 1; stackIndex >= 0; stackIndex -= 1) {
          events.push({ type: 'marker', marker: stack[stackIndex].marker, action: 'close' });
        }
        stack.length = 0;
      }
      pushText('\n');
      inLinkDestination = false;
      linkDestinationDepth = 0;
      lineIndent = 0;
      inTableRow = false;
      inAutolink = false;
      prevChar = '\n';
      atLineStart = true;
      index += 1;
      continue;
    }

    if (atLineStart && (character === ' ' || character === '\t')) {
      pushText(character);
      lineIndent += character === '\t' ? 4 : 1;
      if (lineIndent > 3) atLineStart = false;
      prevChar = character;
      index += 1;
      continue;
    }

    if (atLineStart && (character === '`' || character === '~')) {
      let end = index;
      while (end < input.length && input[end] === character) end += 1;
      const runLength = end - index;
      if (end === input.length) {
        carry = input.slice(index);
        break;
      }
      if (runLength >= 3) {
        const marker = (character === '`' ? '```' : '~~~') as '```' | '~~~';
        if (!inFence || marker === fenceMarker) {
          const newlineAt = input.indexOf('\n', end);
          if (newlineAt < 0) {
            carry = input.slice(index);
            break;
          }
          const action = inFence ? 'close' : 'open';
          if (!inFence) {
            inFence = true;
            fenceMarker = marker;
            stack.length = 0;
          } else {
            inFence = false;
            fenceMarker = null;
          }
          events.push({ type: 'fence', action });
          if (action === 'close') pushText('\n');
          prevChar = '\n';
          atLineStart = true;
          lineIndent = 0;
          inTableRow = false;
          index = newlineAt + 1;
          continue;
        }
      }
    }

    if (inFence) {
      pushText(character);
      prevChar = character;
      atLineStart = false;
      index += 1;
      continue;
    }

    if (inLinkDestination) {
      if (character === '\\' && index < input.length - 1) {
        prevChar = input[index + 1];
        atLineStart = false;
        index += 2;
        continue;
      }
      if (character === '(') {
        linkDestinationDepth += 1;
      } else if (character === ')' && linkDestinationDepth > 0) {
        linkDestinationDepth -= 1;
      } else if (character === ')') {
        inLinkDestination = false;
      }
      prevChar = character;
      atLineStart = false;
      index += 1;
      continue;
    }

    if (inAutolink) {
      if (character === '>') {
        inAutolink = false;
      } else {
        pushText(character);
      }
      prevChar = character;
      atLineStart = false;
      index += 1;
      continue;
    }

    if (inCodeSpan && character !== '`') {
      pushText(character);
      prevChar = character;
      atLineStart = false;
      index += 1;
      continue;
    }

    if (inMath) {
      if (character === '\\' && index === input.length - 1) {
        carry = '\\';
        break;
      }
      if (top.marker === '\\(' && input.startsWith('\\)', index)) {
        stack.pop();
        events.push({ type: 'marker', marker: '\\(', action: 'close' });
        prevChar = ')';
        atLineStart = false;
        index += 2;
        continue;
      }
      if (top.marker === '\\[' && input.startsWith('\\]', index)) {
        stack.pop();
        events.push({ type: 'marker', marker: '\\[', action: 'close' });
        prevChar = ']';
        atLineStart = false;
        index += 2;
        continue;
      }
      if (character !== '$') {
        pushText(character);
        prevChar = character;
        atLineStart = false;
        index += 1;
        continue;
      }
    }

    if (atLineStart) {
      const thematic = thematicLine(input, index);
      if (thematic) {
        if (!thematic.newline) {
          carry = input.slice(index);
          break;
        }
        pushText('\n');
        prevChar = '\n';
        atLineStart = true;
        lineIndent = 0;
        inTableRow = false;
        index = thematic.markerEnd + 1;
        continue;
      }

      if (character === '#') {
        let end = index;
        while (end < input.length && input[end] === '#') end += 1;
        if (end === input.length) {
          carry = input.slice(index);
          break;
        }
        if (end - index <= 6 && (input[end] === ' ' || input[end] === '\t')) {
          while (end < input.length && (input[end] === ' ' || input[end] === '\t')) end += 1;
          prevChar = ' ';
          atLineStart = false;
          index = end;
          continue;
        }
      }

      if (character === '>') {
        if (index === input.length - 1) {
          carry = '>';
          break;
        }
        let end = index + 1;
        if (input[end] === ' ' || input[end] === '\t') end += 1;
        pushText('│ ');
        prevChar = ' ';
        atLineStart = true;
        lineIndent = 0;
        index = end;
        continue;
      }

      if (character === '|' && lineIndent <= 3) {
        pushText('  ');
        inTableRow = true;
        prevChar = '|';
        atLineStart = false;
        index += 1;
        continue;
      }

      if ((character === '-' || character === '+') && index === input.length - 1) {
        carry = character;
        break;
      }

      if ((character === '*' || character === '-' || character === '+') &&
          (input[index + 1] === ' ' || input[index + 1] === '\t')) {
        let end = index + 1;
        while (end < input.length && (input[end] === ' ' || input[end] === '\t')) end += 1;
        const task = taskPrefix(input, end, true);
        if (task === 'incomplete') {
          carry = input.slice(index);
          break;
        }
        if (task) {
          pushText(task.display);
          end = task.end;
        } else {
          pushText('• ');
        }
        prevChar = ' ';
        atLineStart = false;
        index = end;
        continue;
      }

      const ordered = input.slice(index).match(/^(\d{1,9})[.)][ \t]+/);
      if (ordered) {
        let end = index + ordered[0].length;
        const task = taskPrefix(input, end);
        if (task === 'incomplete') {
          carry = input.slice(index);
          break;
        }
        pushText(`${ordered[1]}. `);
        if (task) {
          pushText(task.display);
          end = task.end;
        }
        prevChar = ' ';
        atLineStart = false;
        index = end;
        continue;
      }
    }

    if (inTableRow && character === '|') {
      pushText('  ');
      prevChar = '|';
      index += 1;
      continue;
    }

    if (character === '<') {
      const end = input.indexOf('>', index + 1);
      const next = input[index + 1];
      if (end < 0 && (next === undefined || /[A-Za-z/!?]/.test(next))) {
        const inner = input.slice(index + 1);
        const confirmedAutolink = /^[A-Za-z][A-Za-z\d+.-]*:/.test(inner) ||
          /^[^ <>@]+@[^ <>@]*$/.test(inner);
        if (confirmedAutolink) {
          pushText(inner);
          inAutolink = true;
          prevChar = inner[inner.length - 1] ?? '<';
          atLineStart = false;
          index = input.length;
          continue;
        }
        if (input.length - index <= MAX_HTML_CARRY) {
          carry = input.slice(index);
          break;
        }
      } else if (end >= 0) {
        const inner = input.slice(index + 1, end);
        const autolink = /^[A-Za-z][A-Za-z\d+.-]*:[^ <>]*$/.test(inner) ||
          /^[^ <>@]+@[^ <>@]+$/.test(inner);
        const htmlTag = /^[A-Za-z/!?]/.test(inner);
        if (autolink) pushText(inner);
        else if (!htmlTag) pushText(input.slice(index, end + 1));
        prevChar = '>';
        atLineStart = false;
        index = end + 1;
        continue;
      }
    }

    if (character === '!' && input[index + 1] === '[') {
      stack.push({ marker: '![', offset: index, hasContent: false });
      events.push({ type: 'marker', marker: '![', action: 'open' });
      prevChar = '[';
      atLineStart = false;
      index += 2;
      continue;
    }

    if (character === '!' && index === input.length - 1) {
      carry = '!';
      break;
    }

    if (character === '[') {
      if (index === input.length - 1) {
        carry = '[';
        break;
      }
      stack.push({ marker: '[', offset: index, hasContent: false });
      events.push({ type: 'marker', marker: '[', action: 'open' });
      prevChar = '[';
      atLineStart = false;
      index += 1;
      continue;
    }

    if (character === ']' && isLinkLabel(stack[stack.length - 1]?.marker)) {
      const label = stack.pop()!;
      events.push({ type: 'marker', marker: label.marker, action: 'close' });
      let end = index + 1;
      if (input[end] === '(') {
        inLinkDestination = true;
        linkDestinationDepth = 0;
        end += 1;
      }
      prevChar = ']';
      atLineStart = false;
      index = end;
      continue;
    }

    if (character === '(' && prevChar === ']') {
      inLinkDestination = true;
      linkDestinationDepth = 0;
      prevChar = '(';
      atLineStart = false;
      index += 1;
      continue;
    }

    if (character === '\\') {
      if (index === input.length - 1) {
        carry = '\\';
        break;
      }
      const next = input[index + 1];
      if (next === '(' || next === '[') {
        const marker = next === '(' ? '\\(' : '\\[';
        toggle(marker, index, true, false);
        prevChar = next;
        atLineStart = false;
        index += 2;
        continue;
      }
      if (next === '\n') {
        pushText('\n');
        prevChar = '\n';
        atLineStart = true;
        lineIndent = 0;
        inTableRow = false;
        index += 2;
        continue;
      }
      pushText(escapablePunctuationPattern.test(next) ? next : `\\${next}`);
      prevChar = next;
      atLineStart = false;
      index += 2;
      continue;
    }

    if (character === '`') {
      let end = index;
      while (end < input.length && input[end] === '`') end += 1;
      const runLength = end - index;
      if (end === input.length) {
        carry = input.slice(index);
        break;
      }
      const currentCode = stack[stack.length - 1];
      if (currentCode?.marker === '`') {
        if (currentCode.runLength === runLength) {
          stack.pop();
          events.push({ type: 'marker', marker: '`', action: 'close', runLength });
        } else {
          pushText(input.slice(index, end));
        }
      } else {
        toggle('`', index, true, false, runLength);
      }
      prevChar = '`';
      atLineStart = false;
      index = end;
      continue;
    }

    if (character === '$') {
      let end = index;
      while (end < input.length && input[end] === '$') end += 1;
      const runLength = end - index;
      if (end === input.length) {
        carry = input.slice(index);
        break;
      }
      const canClose = prevChar !== '' && !isSpace(prevChar);
      const canOpen = !isSpace(input[end]);
      let remaining = runLength;
      while (remaining >= 2) {
        toggle('$$', index, canOpen, canClose);
        remaining -= 2;
      }
      if (remaining === 1) {
        if (!inMath && /\d/.test(input[end])) pushText('$');
        else toggle('$', index, canOpen, canClose);
      }
      prevChar = '$';
      atLineStart = false;
      index = end;
      continue;
    }

    if (character === '*') {
      let end = index;
      while (end < input.length && input[end] === '*') end += 1;
      const runLength = end - index;
      if (end === input.length) {
        carry = input.slice(index);
        break;
      }
      const canClose = prevChar !== '' && !isSpace(prevChar);
      const canOpen = !isSpace(input[end]);
      let remaining = runLength;
      while (remaining >= 2) {
        toggle('**', index, canOpen, canClose);
        remaining -= 2;
      }
      if (remaining === 1) toggle('*', index, canOpen, canClose);
      prevChar = '*';
      atLineStart = false;
      index = end;
      continue;
    }

    if (character === '_') {
      let end = index;
      while (end < input.length && input[end] === '_') end += 1;
      const runLength = end - index;
      if (end === input.length) {
        carry = input.slice(index);
        break;
      }
      const canClose = prevChar !== '' && !isSpace(prevChar);
      const canOpen = !isSpace(input[end]);
      if (isWordCharacter(prevChar) && isWordCharacter(input[end])) {
        pushText(input.slice(index, end));
      } else {
        let remaining = runLength;
        while (remaining >= 2) {
          toggle('__', index, canOpen, canClose);
          remaining -= 2;
        }
        if (remaining === 1) toggle('_', index, canOpen, canClose);
      }
      prevChar = '_';
      atLineStart = false;
      index = end;
      continue;
    }

    if (character === '~') {
      let end = index;
      while (end < input.length && input[end] === '~') end += 1;
      const runLength = end - index;
      if (end === input.length) {
        carry = input.slice(index);
        break;
      }
      const canClose = prevChar !== '' && !isSpace(prevChar);
      const canOpen = !isSpace(input[end]);
      let remaining = runLength;
      while (remaining >= 2) {
        toggle('~~', index, canOpen, canClose);
        remaining -= 2;
      }
      if (remaining === 1) pushText('~');
      prevChar = '~';
      atLineStart = false;
      index = end;
      continue;
    }

    let end = index + 1;
    while (
      end < input.length &&
      !isInlineSyntaxCharacter(input[end], inTableRow)
    ) {
      end += 1;
    }
    const plainText = input.slice(index, end);
    pushText(plainText);
    prevChar = plainText[plainText.length - 1];
    atLineStart = false;
    index = end;
  }

  return {
    state: {
      stack,
      inFence,
      fenceMarker,
      inLinkDestination,
      linkDestinationDepth,
      lineIndent,
      inTableRow,
      inAutolink,
      atLineStart,
      prevChar,
    },
    events,
    carry,
  };
}

export interface TailRemendResult {
  /** Unstable-block text to render: raw minus carry, plus ordered closers. */
  displayText: string;
  closers: string;
  /** Characters withheld from display and re-fed ahead of the pending tail. */
  carry: string;
  /** Inline state at the display cut point, used to seed the frame tail. */
  endState: InlineStreamState;
}

const fenceRunAtLineStartPattern = /(?:^|\n)[ \t]{0,3}(`{3,}|~{3,})/g;

function inlineStateAt(blockText: string, offset: number): InlineStreamState {
  if (offset === 0) return INITIAL_INLINE_STATE;

  fenceRunAtLineStartPattern.lastIndex = 0;
  let fenceMarker: '```' | '~~~' | null = null;
  let match: RegExpExecArray | null;
  while ((match = fenceRunAtLineStartPattern.exec(blockText)) !== null) {
    const runStart = match.index + match[0].length - match[1].length;
    if (runStart >= offset) break;
    const marker = (match[1][0] === '`' ? '```' : '~~~') as '```' | '~~~';
    if (fenceMarker === null) fenceMarker = marker;
    else if (fenceMarker === marker) fenceMarker = null;
  }

  return {
    stack: [],
    inFence: fenceMarker !== null,
    fenceMarker,
    inLinkDestination: false,
    linkDestinationDepth: 0,
    lineIndent: 0,
    inTableRow: false,
    inAutolink: false,
    atLineStart: blockText[offset - 1] === '\n',
    prevChar: blockText[offset - 1] ?? '',
  };
}

function rewriteIncompleteLinkTail(text: string): string {
  const imageDestination = text.match(/!\[([^\]\n]*)\]\([^\n)]*$/);
  if (imageDestination?.index !== undefined) {
    return text.slice(0, imageDestination.index) + imageDestination[1];
  }
  const linkDestination = text.match(/(^|[^!])\[([^\]\n]*)\]\([^\n)]*$/);
  if (linkDestination?.index !== undefined) {
    return text.slice(0, linkDestination.index) + linkDestination[1] + linkDestination[2];
  }
  const imageLabel = text.match(/!\[([^\]\n]*)$/);
  if (imageLabel?.index !== undefined) {
    return text.slice(0, imageLabel.index) + imageLabel[1];
  }
  const linkLabel = text.match(/(^|[^!])\[([^\]\n]*)$/);
  if (linkLabel?.index !== undefined) {
    return text.slice(0, linkLabel.index) + linkLabel[1] + linkLabel[2];
  }
  return text;
}

function stripIncompleteHtmlTail(text: string): string {
  return text.replace(/<[A-Za-z/!?][^>\n]*$/, '');
}

/**
 * Compute display-only fake closers for the unstable snapshot block.
 *
 * Callers must retain the original block text in committed streaming state;
 * feeding displayText back into the incremental splitter would violate its
 * append-only prefix invariant.
 */
export function computeTailRemend(blockText: string): TailRemendResult {
  const paragraphBreak = blockText.lastIndexOf('\n\n');
  const scanFrom = paragraphBreak >= 0 ? paragraphBreak + 2 : 0;
  const scanText = blockText.slice(scanFrom);
  const probe = scanInline(scanText, inlineStateAt(blockText, scanFrom));
  let cut = scanText.length - probe.carry.length;
  const trimmed = [...probe.state.stack];

  while (trimmed.length > 0 && !trimmed[trimmed.length - 1].hasContent) {
    cut = Math.min(cut, trimmed[trimmed.length - 1].offset);
    trimmed.pop();
  }

  const rescan = cut === scanText.length
    ? probe
    : scanInline(scanText.slice(0, cut), inlineStateAt(blockText, scanFrom));
  const closers = [...rescan.state.stack]
    .reverse()
    .filter((delimiter) => delimiter.hasContent)
    .map(delimiterCloser)
    .join('');
  const displayBase = blockText.slice(0, scanFrom) + scanText.slice(0, cut);
  const safeDisplayBase = stripIncompleteHtmlTail(rewriteIncompleteLinkTail(displayBase));

  return {
    displayText: safeDisplayBase + closers,
    closers,
    carry: scanText.slice(cut),
    endState: rescan.state,
  };
}

export interface TailSegment {
  text: string;
  bold: boolean;
  italic: boolean;
  codeFont: boolean;
  strike?: boolean;
}

/**
 * Re-scan the short pending tail from the snapshot end state and turn it into
 * styled display segments. Syntax delimiters are hidden while their content
 * keeps a lightweight semantic preview. No Markdown parser runs here.
 */
export function buildTailSegments(
  pendingText: string,
  initial: InlineStreamState,
): { segments: TailSegment[]; carry: string; endState: InlineStreamState } {
  const scan = scanInline(pendingText, initial);
  const delimiters: OpenDelimiter[] = initial.stack.map((delimiter) => ({ ...delimiter }));
  const segments: TailSegment[] = [];
  let inFence = initial.inFence;

  const styleNow = (): Omit<TailSegment, 'text'> => {
    const markers = delimiters.map((delimiter) => delimiter.marker);
    const inMath = markers.some(isMathMarker);
    const style: Omit<TailSegment, 'text'> = {
      bold: !inMath && (markers.includes('**') || markers.includes('__')),
      italic: !inMath && (markers.includes('*') || markers.includes('_')),
      codeFont: !inMath && (markers.includes('`') || inFence),
    };
    if (!inMath && markers.includes('~~')) style.strike = true;
    return style;
  };

  const append = (text: string) => {
    if (!text) return;
    const style = styleNow();
    const last = segments[segments.length - 1];
    if (
      last &&
      last.bold === style.bold &&
      last.italic === style.italic &&
      last.codeFont === style.codeFont &&
      !!last.strike === !!style.strike
    ) {
      last.text += text;
    } else {
      segments.push({ text, ...style });
    }
  };

  for (const event of scan.events) {
    if (event.type === 'text') {
      append(event.text);
      continue;
    }

    if (event.type === 'fence') {
      inFence = event.action === 'open';
      continue;
    }

    if (event.action === 'open') {
      delimiters.push({
        marker: event.marker,
        offset: 0,
        hasContent: false,
        runLength: event.runLength,
      });
    } else {
      let delimiterIndex = -1;
      for (let index = delimiters.length - 1; index >= 0; index -= 1) {
        const delimiter = delimiters[index];
        if (
          delimiter.marker === event.marker &&
          (event.marker !== '`' || delimiter.runLength === event.runLength)
        ) {
          delimiterIndex = index;
          break;
        }
      }
      if (delimiterIndex >= 0) delimiters.splice(delimiterIndex, 1);
    }
  }

  return { segments, carry: scan.carry, endState: scan.state };
}

export interface IncrementalTailSegmentsState {
  text: string;
  segments: TailSegment[];
  carry: string;
  /** State after the consumed prefix; carry has not been applied yet. */
  endState: InlineStreamState;
}

function mergeTailSegments(
  base: readonly TailSegment[],
  suffix: readonly TailSegment[],
): TailSegment[] {
  const merged = [...base];
  for (const segment of suffix) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.bold === segment.bold &&
      last.italic === segment.italic &&
      last.codeFont === segment.codeFont &&
      !!last.strike === !!segment.strike
    ) {
      merged[merged.length - 1] = { ...last, text: last.text + segment.text };
    } else {
      merged.push(segment);
    }
  }
  return merged;
}

/**
 * Incrementally extend pending-tail segments. A trailing ambiguous carry is
 * re-fed with the newly appended suffix, so delimiter identity may resolve
 * without rescanning the already consumed prefix.
 */
export function updateTailSegments(
  previous: IncrementalTailSegmentsState | null,
  pendingText: string,
  initial: InlineStreamState,
): IncrementalTailSegmentsState {
  if (!previous || !pendingText.startsWith(previous.text)) {
    const full = buildTailSegments(pendingText, initial);
    return { text: pendingText, ...full };
  }
  if (pendingText === previous.text) return previous;

  const appended = pendingText.slice(previous.text.length);
  const suffix = buildTailSegments(previous.carry + appended, previous.endState);
  return {
    text: pendingText,
    segments: mergeTailSegments(previous.segments, suffix.segments),
    carry: suffix.carry,
    endState: suffix.endState,
  };
}
