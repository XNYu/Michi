import type { MichiContextItem } from 'michi-shared';

/** Where the user was when they called the assistant; it answers with that page in mind. */
export interface MichiAssistantPage {
  kind: 'home' | 'page' | 'threads' | 'pane' | 'other';
  projectId?: string;
  nodeId?: string;
}

export interface OpenMichiAssistantOptions {
  /** Shown as chips above the assistant's composer. */
  attachments?: MichiContextItem[];
  /** Pre-filled composer text. */
  prompt?: string;
  /** Send `prompt` right away instead of leaving it in the composer. */
  send?: boolean;
  page?: MichiAssistantPage;
}

export const MICHI_ASSISTANT_OPEN_EVENT = 'michi:assistant-open';

/**
 * Open the ⌘J assistant panel. Any surface may call this; the panel listens
 * for the event, so callers never import the panel itself.
 */
export function openMichiAssistant(options: OpenMichiAssistantOptions = {}): void {
  window.dispatchEvent(new CustomEvent<OpenMichiAssistantOptions>(MICHI_ASSISTANT_OPEN_EVENT, { detail: options }));
}
