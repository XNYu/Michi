import { formatFileSnapshotContext } from '../state/fileFeedback';
import type { AnyQuoteSource, AttachedQuoteSource } from './quoteSource';

export type { AnyQuoteSource, AttachedQuoteSource, QuoteSource } from './quoteSource';

const QUOTED_SELECTION_CONTEXT =
  'Context: The user selected the passage below from the previous assistant reply. Treat it as source context, not as text authored by the user.';

const ATTACHED_CONTEXT =
  'Context: The user attached the material below in Michi: what was on screen, items they handed over (threads, blocks, rows) and any passage they selected. Treat it as source context, not as text authored by the user.';

export const ATTACHED_QUOTE_SOURCE: AttachedQuoteSource = { type: 'attached' };

export function formatQuoteBlock(quote: string): string {
  return quote
    .trim()
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.startsWith('>') ? line : `> ${line}`))
    .join('\n');
}

export function formatQuotedSelectionContext(quote: string, source?: AnyQuoteSource): string {
  const trimmedQuote = quote.trim();
  if (!trimmedQuote) return '';

  if (source?.type === 'attached') {
    return [ATTACHED_CONTEXT, '', 'Attached context:', formatQuoteBlock(trimmedQuote)].join('\n');
  }

  if (source?.type === 'artifact') {
    const label = source.name ? `artifact "${source.name}"` : 'an artifact document';
    const contextLine = `Context: The user selected the passage below from ${label} at \`${source.filePath}\`. Treat it as source context, not as text authored by the user.`;
    return [
      contextLine,
      '',
      'Selected passage:',
      formatQuoteBlock(trimmedQuote),
      '',
      source.snapshot
        ? formatFileSnapshotContext(source.snapshot)
        : `The full document is available at \`${source.filePath}\`. Read it if you need more context.`,
    ].join('\n');
  }

  return [
    QUOTED_SELECTION_CONTEXT,
    '',
    'Selected assistant passage:',
    formatQuoteBlock(trimmedQuote),
  ].join('\n');
}

/**
 * Compose the wire prompt for creating a child branch from a selected
 * assistant passage. UI stores the quote as structured metadata, but the
 * agent only sees this text, so keep the authorship boundary explicit.
 *
 * When `source` is provided, the context prefix identifies the artifact
 * document and appends a "read the full document" instruction for the agent.
 */
export function formatQuotedMessage(quote: string, prompt: string, source?: AnyQuoteSource): string {
  const trimmedQuote = quote.trim();
  const trimmedPrompt = prompt.trim();
  if (!trimmedQuote) return trimmedPrompt;
  const context = formatQuotedSelectionContext(trimmedQuote, source);
  if (!trimmedPrompt) return context;
  return `${context}\n\nUser's branch question:\n${trimmedPrompt}`;
}
