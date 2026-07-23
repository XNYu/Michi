const QUOTED_SELECTION_CONTEXT =
  'Context: The user selected the passage below from the previous assistant reply. Treat it as source context, not as text authored by the user.';

/**
 * Optional source metadata for the selection. When the selection comes from
 * an artifact file (rather than a chat message), the context prefix and
 * follow-up instruction change so the agent knows which document it came from.
 */
export interface QuoteSource {
  type: 'artifact';
  /** Display name of the artifact (e.g. "API Spec"). */
  name?: string;
  /** File path relative to the workspace cwd. */
  filePath: string;
}

export function formatQuoteBlock(quote: string): string {
  return quote
    .trim()
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.startsWith('>') ? line : `> ${line}`))
    .join('\n');
}

export function formatQuotedSelectionContext(quote: string, source?: QuoteSource): string {
  const trimmedQuote = quote.trim();
  if (!trimmedQuote) return '';

  if (source?.type === 'artifact') {
    const label = source.name ? `artifact "${source.name}"` : 'an artifact document';
    const contextLine = `Context: The user selected the passage below from ${label} at \`${source.filePath}\`. Treat it as source context, not as text authored by the user.`;
    return [
      contextLine,
      '',
      'Selected passage:',
      formatQuoteBlock(trimmedQuote),
      '',
      `The full document is available at \`${source.filePath}\`. Read it if you need more context.`,
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
export function formatQuotedMessage(quote: string, prompt: string, source?: QuoteSource): string {
  const trimmedQuote = quote.trim();
  const trimmedPrompt = prompt.trim();
  if (!trimmedQuote) return trimmedPrompt;
  const context = formatQuotedSelectionContext(trimmedQuote, source);
  if (!trimmedPrompt) return context;
  return `${context}\n\nUser's branch question:\n${trimmedPrompt}`;
}
