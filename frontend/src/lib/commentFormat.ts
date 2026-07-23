import type { PendingComment } from '../state/chatTypes';
import { formatQuoteBlock, formatQuotedSelectionContext } from './quoteFormat';

/**
 * Soft cap for how much of a quoted passage we echo back into the outgoing
 * prompt block. The rendered LLM context already has the full text nearby,
 * so we truncate very long selections in the middle to keep the prompt
 * lean. Picked at 100 chars per the UX spec. Counts Unicode code points,
 * not UTF-16 units, so it behaves for CJK text.
 */
export const QUOTE_PREVIEW_MAX = 100;

/**
 * Shorten a passage to at most QUOTE_PREVIEW_MAX code points using a
 * middle-ellipsis (`head … tail`) so both ends of the selection remain
 * visible to the agent. If the input fits, it's returned unchanged.
 *
 * The ellipsis is three ASCII dots surrounded by spaces so it round-trips
 * cleanly through markdown; the head/tail split is biased toward the head
 * by one character when the budget is odd.
 */
export function truncateQuotePreview(
  text: string,
  max: number = QUOTE_PREVIEW_MAX,
): string {
  const glyphs = Array.from(text);
  if (glyphs.length <= max) return text;
  const budget = max - 3; // reserve ` ... ` — counted generously.
  const headLen = Math.ceil(budget / 2);
  const tailLen = budget - headLen;
  const head = glyphs.slice(0, headLen).join('').trimEnd();
  const tail = glyphs.slice(glyphs.length - tailLen).join('').trimStart();
  return `${head} ... ${tail}`;
}

/**
 * Render a single PendingComment as a Markdown block:
 *
 *     > {quote line 1}
 *     > {quote line 2}
 *
 *     {body}
 *
 * The quote is truncated via truncateQuotePreview so runaway selections
 * don't bloat the prompt. Quote lines already starting with `>` are kept
 * as-is so nested blockquotes don't get double-prefixed.
 *
 * When the comment carries artifact source metadata, an attribution line
 * and a "read full document" instruction are included so the agent knows
 * which file the selection came from.
 */
export function renderComment(c: PendingComment): string {
  const preview = truncateQuotePreview(c.quotedText.trim());
  const body = c.body.trim();

  if (c.source?.type === 'artifact') {
    const label = c.source.name ? `artifact "${c.source.name}"` : 'an artifact document';
    const attribution = `From ${label} at \`${c.source.filePath}\`:`;
    const quoted = formatQuoteBlock(preview);
    const readHint = `The full document is available at \`${c.source.filePath}\`. Read it if you need more context.`;
    const parts = [attribution, '', quoted];
    if (body) parts.push('', body);
    parts.push('', readHint);
    return parts.join('\n');
  }

  const quoted = formatQuoteBlock(preview);
  return body ? `${quoted}\n\n${body}` : quoted;
}

/**
 * Format a batch of PendingComments into a markdown block that is
 * prepended to the next outgoing user message. Separator between
 * comments is a horizontal rule so the agent can clearly delimit
 * individual comments even when rendered.
 *
 * Empty input returns an empty string.
 */
export function formatCommentsBlock(comments: PendingComment[]): string {
  if (comments.length === 0) return '';
  const body = comments.map(renderComment).join('\n\n---\n\n');
  return `## My Comments on Previous Reply\n\n${body}`;
}

/**
 * Combine the three possible pieces of an outgoing user message — a
 * prepended comment block, a classic quote-reply bar, and the user's
 * typed text — into the final string that gets sent to the agent.
 *
 * Any combination of the three may be empty/null. When the comment block
 * and the quote-reply exist together, the comment block comes first so
 * the agent sees the accumulated context before the fresh quote.
 */
export function joinMessageParts(
  commentBlock: string | null,
  quoted: string | null,
  userText: string,
): string {
  const parts: string[] = [];
  const trimmedBlock = commentBlock?.trim() ?? '';
  if (trimmedBlock) parts.push(trimmedBlock);
  const trimmedQuote = quoted?.trim() ?? '';
  if (trimmedQuote) {
    parts.push(formatQuotedSelectionContext(trimmedQuote));
  }
  const trimmedText = userText.trim();
  if (trimmedText) {
    parts.push(trimmedQuote ? `User's reply:\n${trimmedText}` : trimmedText);
  }
  return parts.join('\n\n');
}
