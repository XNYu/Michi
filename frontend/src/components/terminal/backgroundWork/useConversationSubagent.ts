import { useCallback, useContext, useRef, useSyncExternalStore } from 'react';
import { ChatNodeStoreContext } from '../../../state/chatStore';
import { conversationSubagentState, type ConversationSubagentState } from '../../../state/backgroundWork';
import { selectLiveBackgroundSubagents, useOptionalWorkflowDomain } from '../../../state/workflowDomain';

const noSubscription = () => () => {};

/**
 * One subagent as its conversation knows it (copies from every turn folded,
 * whether it runs now, stopped once no live process tracks it), for the
 * transcript line of the message that holds one copy. Undefined without a
 * conversation or a chat store (specimens, provider-free tests).
 *
 * Subagent updates are HIGH_FREQ actions, so this subscribes to that node
 * (and the workflow domain, for liveness) only and returns the previous
 * value until the folded agent or its running state changes: stream chunks
 * and workflow progress do not re-render the line.
 */
export function useConversationSubagent(nodeId: string | null, sessionId: string | undefined): ConversationSubagentState | undefined {
  const store = useContext(ChatNodeStoreContext);
  const workflows = useOptionalWorkflowDomain()?.store;
  const last = useRef<ConversationSubagentState | undefined>(undefined);
  const subscribe = useCallback((listener: () => void) => {
    if (!store || !nodeId || !sessionId) return noSubscription();
    const unsubscribeNode = store.subscribeNode(nodeId, listener);
    const unsubscribeLiveness = workflows?.subscribe(listener);
    return () => { unsubscribeNode(); unsubscribeLiveness?.(); };
  }, [store, workflows, nodeId, sessionId]);
  const getSnapshot = useCallback(() => {
    const node = store && nodeId && sessionId ? store.getNode(nodeId) : undefined;
    // The node's workspace is its project: the feed its liveness comes on.
    const live = node && workflows ? selectLiveBackgroundSubagents(workflows.getState(), node.projectId, node.nodeId) : undefined;
    const next = node && sessionId ? conversationSubagentState(node, sessionId, live) : undefined;
    const previous = last.current;
    if (previous && next
      && previous.subagent === next.subagent
      && previous.messageId === next.messageId
      && previous.active === next.active) {
      return previous;
    }
    last.current = next;
    return next;
  }, [store, workflows, nodeId, sessionId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
