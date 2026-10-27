import type { ChatNodeState } from './chatTypes';

/** Whether a hydrated node belongs in ordinary conversation surfaces.
 * Page helpers remain in authoritative workspace state for embedded rendering,
 * but are hidden until promoted (the backend clears `page_id` on promotion).
 * Meta agent maintenance transcripts stay in state too, reachable from
 * Scheduled, and are never shown among the user's conversations.
 * System workspace policy remains enforced by each surface as before. */
export function isVisibleConversationNode(node: Pick<ChatNodeState, 'pageId' | 'maintenanceJobId'> | null | undefined): boolean {
  return !node?.pageId && !node?.maintenanceJobId;
}
