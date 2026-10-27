import { HOME_CONVERSATION_LIST_LIMITS } from 'michi-shared';
import { serverEntityId } from '../../../config/backendIdentity';
import { fetchHomeConversations } from '../../../services/api/spacesHome';
import type { ConversationChoice } from '../content/db/liveThreads';

/** The workspace's newest conversations a task can link, by the ids its Conversations cell holds (the server's). */
export async function workspaceConversations(connectionId: string, workspaceId: string): Promise<ConversationChoice[]> {
  const { items } = await fetchHomeConversations(connectionId, { workspaceId, limit: HOME_CONVERSATION_LIST_LIMITS.max });
  return items.flatMap((item) => (item.target.kind === 'conversation'
    ? [{ nodeId: serverEntityId(item.target.nodeId, connectionId), title: item.title, state: item.state, at: item.at }]
    : []));
}
