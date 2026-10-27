import type { ChatStreamPayloads, SubagentActivityPayload } from 'michi-shared';
import type { ChatAction } from './chatTypes';

/** Copy only the activity contract fields; stream envelope fields
 *  (seq, turnId, chatId…) must not leak into reducer state. */
export function subagentActivityFields(data: ChatStreamPayloads['subagent_tool_activity']): SubagentActivityPayload {
  return {
    subagentSessionId: data.subagentSessionId,
    title: data.title,
    status: data.status,
    ...(data.toolCallId ? { toolCallId: data.toolCallId } : {}),
    ...(data.toolKind ? { toolKind: data.toolKind } : {}),
    ...(data.detail ? { detail: data.detail } : {}),
    ...(data.output ? { output: data.output } : {}),
    ...(data.activityKind ? { activityKind: data.activityKind } : {}),
    ...(data.at !== undefined ? { at: data.at } : {}),
  };
}

export function subagentListAction(
  nodeId: string,
  assistantId: string | undefined | null,
  data: ChatStreamPayloads['subagent_list_update'],
): ChatAction {
  return { type: 'subagent-list-update', nodeId, ...(assistantId ? { assistantId } : {}), subagents: data.subagents };
}

export function subagentActivityAction(
  nodeId: string,
  assistantId: string | undefined | null,
  data: ChatStreamPayloads['subagent_tool_activity'],
): ChatAction {
  return {
    type: 'subagent-tool-activity',
    nodeId,
    ...(assistantId ? { assistantId } : {}),
    ...subagentActivityFields(data),
  };
}
