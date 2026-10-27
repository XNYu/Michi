import type { ChatNodeState } from '../state/chatTypes';
import { visibleMessageText } from '../state/assistantBlocks';
import type { DigestGenerationPayload } from '../services/digestApi';

/** This is the exact source material consumed by digest generation and freshness. */
export function digestSourceSnapshot(node: ChatNodeState): DigestGenerationPayload['nodes'][number] {
  return {
    nodeId: node.nodeId,
    parentNodeId: node.parentNodeId,
    title: node.title,
    depth: 0,
    messages: node.messages
      .map((message) => ({ role: message.role, text: visibleMessageText(message) }))
      .filter((message) => !!message.text),
  };
}
