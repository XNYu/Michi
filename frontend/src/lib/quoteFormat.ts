const QUOTED_SELECTION_CONTEXT =
  'Context: The user selected the passage below from the previous assistant reply. Treat it as source context, not as text authored by the user.';

export function formatQuoteBlock(quote: string): string {
  return quote
    .trim()
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.startsWith('>') ? line : `> ${line}`))
    .join('\n');
}

export function formatQuotedSelectionContext(quote: string): string {
  const trimmedQuote = quote.trim();
  if (!trimmedQuote) return '';
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
 */
export function formatQuotedMessage(quote: string, prompt: string): string {
  const trimmedQuote = quote.trim();
  const trimmedPrompt = prompt.trim();
  if (!trimmedQuote) return trimmedPrompt;
  const context = formatQuotedSelectionContext(trimmedQuote);
  if (!trimmedPrompt) return context;
  return `${context}\n\nUser's branch question:\n${trimmedPrompt}`;
}
