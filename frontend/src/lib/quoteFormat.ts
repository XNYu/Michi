import { formatFileSnapshotContext, type FileReadSnapshot } from '../state/fileFeedback';

const QUOTED_SELECTION_CONTEXT =
  'Context: The user selected the passage below from the previous assistant reply. Treat it as source context, not as text authored by the user.';

const ATTACHED_CONTEXT =
  'Context: The user attached the material below in Michi: what was on screen, items they handed over (threads, blocks, rows) and any passage they selected. Treat it as source context, not as text authored by the user.';

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
  /**
   * W3C Web Annotation-aligned text selector for precise anchoring.
   * Optional — only populated when the selection can be mapped to
   * character offsets in the source document.
   */
  selector?: import('./textSelector').TextSelector;
  snapshot?: FileReadSnapshot;
}

/**
 * Context the user attached rather than selected from a reply: the ⌘J
 * assistant's page line and the Michi items handed to it (any selection the
 * user also quoted rides in the same block).
 */
export interface AttachedQuoteSource {
  type: 'attached';
}

/** Every source a quote's framing can name: an artifact, or attached context. */
export type AnyQuoteSource = QuoteSource | AttachedQuoteSource;

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
