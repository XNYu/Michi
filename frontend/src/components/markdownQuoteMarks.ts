import { createContext, type ReactNode } from 'react';
import type { MarkdownQuote } from './rehypeQuoteMarks';

/**
 * Opt-in marks over quoted passages inside MarkdownContent. Without a
 * provider (every caller by default) nothing is matched or marked. With one,
 * each MarkdownContent below marks the first occurrence of every quote in its
 * rendered text (see rehypeQuoteMarks) and renders each mark through `render`.
 */
export interface MarkdownQuoteMarks {
  /**
   * The passages to mark. Keep this array stable: a new one re-renders every
   * MarkdownContent below, and re-parses its Markdown.
   */
  quotes: readonly MarkdownQuote[];
  /** Renders one marked stretch of text; `keys` name the quotes it covers. */
  render(keys: readonly string[], children: ReactNode): ReactNode;
}

export const MarkdownQuoteMarksContext = createContext<MarkdownQuoteMarks | null>(null);
