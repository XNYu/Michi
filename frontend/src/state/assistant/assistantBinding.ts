import type { AgentReasoning, AgentStatus } from '../../services/api';
import type { AssistantInfo } from '../../services/api/assistant';
import type { ChatNodeState } from '../chatTypes';
import type { ResolvedNodeBinding } from '../nodeBindingResolution';

/**
 * The runtime, model and reasoning an assistant conversation that is not the
 * current one runs on, for its composer to show. The backend pins them on
 * every session path (the conversation's own pick, else the global
 * settings), so this composer offers no choice and a send carries none.
 *
 * A conversation that has run says what it ran on itself (each send writes
 * the backend's binding back to the node); before its first send, the
 * current conversation is what the assistant info says.
 */
export function assistantComposerBinding(
  node: ChatNodeState | null | undefined,
  info: AssistantInfo | null | undefined,
  agentStatus: AgentStatus | null | undefined,
): ResolvedNodeBinding {
  if (node?.runtimeId) {
    return {
      runtime: node.runtimeId,
      provider: node.providerId ?? undefined,
      model: node.modelId ?? undefined,
      reasoning: (node.reasoning as AgentReasoning | null | undefined) ?? undefined,
      source: 'node',
    };
  }
  const current = info && node && info.nodeId === node.nodeId ? info.conversation ?? info.settings : null;
  return {
    runtime: current?.runtimeId ?? agentStatus?.runtime ?? 'claude',
    provider: undefined,
    model: current?.modelId ?? undefined,
    reasoning: current?.reasoning ?? undefined,
    source: 'node',
  };
}
