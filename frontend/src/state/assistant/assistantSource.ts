import type { AssistantInfo } from '../../services/api/assistant';

/**
 * Where an assistant window's current conversation lives, for the composer
 * that shows it (TPane). The Spaces window and the ⌘J panel use the global
 * assistant store, which TPane reads by default; the Scheduled window passes
 * its own conversation's.
 */
export interface AssistantConversationSource {
  /** The window's current conversation, as rendered. */
  info: AssistantInfo | null;
  /** The same, read after an await. */
  current: () => AssistantInfo | null;
  /** The backend answered with this window's conversation (a composer pick, settings read again). */
  adopt: (info: AssistantInfo) => void;
  /** Reads this window's conversation from the backend again. */
  refetch: () => Promise<AssistantInfo>;
}
