import { createContext, useContext } from 'react';

/**
 * True inside the assistant's conversation (the ⌘J panel, or its node opened
 * as a pane). Assistant-only rendering (Michi receipt cards) checks it, so a
 * tool of the same name in any other conversation renders as it always did.
 */
export const AssistantScopeContext = createContext(false);

export function useInAssistantScope(): boolean {
  return useContext(AssistantScopeContext);
}
