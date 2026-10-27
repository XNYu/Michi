import { createContext, useContext, type ReactNode } from 'react';
import type { ChatMessage, ToolCallState } from '../chatTypes';

/**
 * How the Spaces Meta agent window dresses the assistant conversation it
 * shows through the shared message list. Every field is optional and the
 * message components behave as before without a provider.
 */
export interface MetaChatDecorations {
  /** Replaces the "> michi" speaker line above an assistant reply. */
  assistantLabel?: ReactNode;
  /** A one-line label per tool call; tool groups then list every call as one row. */
  toolLine?: (tool: ToolCallState) => string | null;
  /** Replaces a reply's page-write receipts with the window's cards (page changes, started conversations). */
  toolCards?: (tools: readonly ToolCallState[]) => ReactNode;
  /** Rendered after a message, e.g. a "From here on: Kiro" divider. */
  afterMessage?: (message: ChatMessage) => ReactNode;
}

export const MetaChatDecorationsContext = createContext<MetaChatDecorations | null>(null);

export function useMetaChatDecorations(): MetaChatDecorations | null {
  return useContext(MetaChatDecorationsContext);
}
