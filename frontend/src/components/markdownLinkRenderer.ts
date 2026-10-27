import { createContext, type ReactNode } from 'react';

/**
 * Opt-in rendering for app links inside MarkdownContent. Without a provider
 * (every caller by default) links render exactly as before and URL schemes
 * other than the usual web ones are stripped. A provider claims a narrow set
 * of hrefs: those survive sanitizing and render through `render`; anything it
 * doesn't claim is still stripped.
 */
export interface MarkdownLinkRenderer {
  /** URL schemes (without `:`) the claimed links use, so sanitizing keeps them. */
  protocols: readonly string[];
  /** True for the exact hrefs this renderer owns. */
  matches(href: string): boolean;
  render(href: string, children: ReactNode): ReactNode;
}

export const MarkdownLinkRendererContext = createContext<MarkdownLinkRenderer | null>(null);
