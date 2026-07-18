import { Lexer, type Token } from 'marked';

const footnoteReferencePattern = /\[\^[\w-]{1,200}\](?!:)/;
const footnoteDefinitionPattern = /\[\^[\w-]{1,200}\]:/;
const openingTagPattern = /<(\w+)[\s>]/;

const voidElements = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const openTagPatternCache = new Map<string, RegExp>();
const closeTagPatternCache = new Map<string, RegExp>();

export interface StreamingMarkdownBlock {
  index: number;
  text: string;
  start: number;
  end: number;
}

/**
 * Committed parser state for append-only streaming Markdown.
 *
 * `parsedFrom` is primarily diagnostic/test metadata: zero means the whole
 * document was parsed, while a positive value means only the unstable tail
 * beginning at that source offset was re-lexed.
 */
export interface IncrementalStreamingMarkdownBlockState {
  markdown: string;
  blocks: StreamingMarkdownBlock[];
  parsedFrom: number;
}

function openTagPattern(tagName: string): RegExp {
  const normalized = tagName.toLowerCase();
  const cached = openTagPatternCache.get(normalized);
  if (cached) return cached;
  const pattern = new RegExp(`<${normalized}(?=[\\s>/])[^>]*>`, 'gi');
  openTagPatternCache.set(normalized, pattern);
  return pattern;
}

function closeTagPattern(tagName: string): RegExp {
  const normalized = tagName.toLowerCase();
  const cached = closeTagPatternCache.get(normalized);
  if (cached) return cached;
  const pattern = new RegExp(`</${normalized}(?=[\\s>])[^>]*>`, 'gi');
  closeTagPatternCache.set(normalized, pattern);
  return pattern;
}

function countNonSelfClosingOpenTags(text: string, tagName: string): number {
  if (voidElements.has(tagName.toLowerCase())) return 0;
  const matches = text.match(openTagPattern(tagName));
  if (!matches) return 0;
  let count = 0;
  for (const match of matches) {
    if (!match.trimEnd().endsWith('/>')) count += 1;
  }
  return count;
}

function countClosingTags(text: string, tagName: string): number {
  return text.match(closeTagPattern(tagName))?.length ?? 0;
}

function countDoubleDollars(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length - 1; i += 1) {
    if (text[i] === '$' && text[i + 1] === '$') {
      count += 1;
      i += 1;
    }
  }
  return count;
}

function tokenRaw(token: Token): string {
  return typeof token.raw === 'string' ? token.raw : '';
}

/**
 * Streamdown-style block splitter for streaming Markdown.
 *
 * This deliberately starts from marked's GFM lexer rather than paragraph regexes,
 * then conservatively merges constructs that need one markdown tree.
 */
export function splitStreamingMarkdownBlocks(markdown: string): StreamingMarkdownBlock[] {
  if (markdown.length === 0) return [];

  if (footnoteReferencePattern.test(markdown) || footnoteDefinitionPattern.test(markdown)) {
    return [{ index: 0, text: markdown, start: 0, end: markdown.length }];
  }

  const tokens = Lexer.lex(markdown, { gfm: true });
  const blocks: string[] = [];
  const htmlStack: string[] = [];
  let previousTokenWasCode = false;

  for (const token of tokens) {
    const currentBlock = tokenRaw(token);
    if (!currentBlock) continue;
    const lastIndex = blocks.length - 1;

    if (htmlStack.length > 0 && lastIndex >= 0) {
      blocks[lastIndex] += currentBlock;
      const trackedTag = htmlStack[htmlStack.length - 1];
      const opens = countNonSelfClosingOpenTags(currentBlock, trackedTag);
      const closes = countClosingTags(currentBlock, trackedTag);
      for (let i = 0; i < opens; i += 1) htmlStack.push(trackedTag);
      for (let i = 0; i < closes; i += 1) {
        if (htmlStack[htmlStack.length - 1] === trackedTag) htmlStack.pop();
      }
      continue;
    }

    if (token.type === 'html' && (token as { block?: boolean }).block) {
      const match = currentBlock.match(openingTagPattern);
      if (match) {
        const tagName = match[1];
        const opens = countNonSelfClosingOpenTags(currentBlock, tagName);
        const closes = countClosingTags(currentBlock, tagName);
        if (opens > closes) htmlStack.push(tagName);
      }
    }

    if (lastIndex >= 0 && !previousTokenWasCode) {
      const previousBlock = blocks[lastIndex];
      if (countDoubleDollars(previousBlock) % 2 === 1) {
        blocks[lastIndex] = previousBlock + currentBlock;
        continue;
      }
    }

    blocks.push(currentBlock);
    if (token.type !== 'space') previousTokenWasCode = token.type === 'code';
  }

  let cursor = 0;
  return blocks.map((text, index) => {
    const start = cursor;
    const end = start + text.length;
    cursor = end;
    return { index, text, start, end };
  });
}

function fullStreamingMarkdownBlockState(markdown: string): IncrementalStreamingMarkdownBlockState {
  return {
    markdown,
    blocks: splitStreamingMarkdownBlocks(markdown),
    parsedFrom: 0,
  };
}

/**
 * Incrementally split append-only streaming Markdown.
 *
 * A Marked block token can still change while text is appended (a paragraph
 * can become a setext heading, a table delimiter can turn preceding text into
 * a table, an open fence can keep growing, and so on). The final block is
 * therefore always treated as unstable and re-lexed together with the new
 * suffix. Every earlier block is already separated from the tail by a lexer
 * boundary and is reused by reference.
 *
 * Cross-document constructs that the regular splitter intentionally keeps in
 * one tree (currently footnotes) conservatively force a full parse. Replaced or
 * truncated text also falls back to a full parse. The non-streaming renderer
 * still performs its normal full parse after the stream completes.
 */
export function updateStreamingMarkdownBlocks(
  previous: IncrementalStreamingMarkdownBlockState | null,
  markdown: string,
): IncrementalStreamingMarkdownBlockState {
  if (!previous || markdown.length === 0) {
    return fullStreamingMarkdownBlockState(markdown);
  }
  if (markdown === previous.markdown) return previous;
  if (!markdown.startsWith(previous.markdown)) {
    return fullStreamingMarkdownBlockState(markdown);
  }
  if (footnoteReferencePattern.test(markdown) || footnoteDefinitionPattern.test(markdown)) {
    return fullStreamingMarkdownBlockState(markdown);
  }
  if (previous.blocks.length === 0) {
    return fullStreamingMarkdownBlockState(markdown);
  }

  const unstableIndex = previous.blocks.length - 1;
  const unstableBlock = previous.blocks[unstableIndex];
  const parsedFrom = unstableBlock.start;
  const stableBlocks = previous.blocks.slice(0, unstableIndex);
  const tailBlocks = splitStreamingMarkdownBlocks(markdown.slice(parsedFrom)).map((block, index) => ({
    ...block,
    index: stableBlocks.length + index,
    start: block.start + parsedFrom,
    end: block.end + parsedFrom,
  }));

  return {
    markdown,
    blocks: [...stableBlocks, ...tailBlocks],
    parsedFrom,
  };
}

export function revealTailCharsForBlock(
  block: StreamingMarkdownBlock,
  totalTextLength: number,
  revealTailChars: number | undefined,
): number | undefined {
  if (!revealTailChars || revealTailChars <= 0) return undefined;
  const revealFrom = Math.max(0, totalTextLength - revealTailChars);
  if (block.end <= revealFrom) return undefined;
  return block.end - Math.max(block.start, revealFrom);
}
