import { useMemo } from 'react';
import type { SubagentInfo, ToolCallState } from '../../../state/chatTypes';
import { useBackgroundWorkNodeId } from '../backgroundWork/backgroundWorkEvents';
import { useConversationSubagent } from '../backgroundWork/useConversationSubagent';
import { subagentToolInfo } from '../toolCallGrouping';
import {
  SUBAGENT_TONE_LABEL,
  shownSubagent,
  subagentsForTool,
  subagentTone,
  type SubagentTone,
} from './subagentPresentation';

/** The roster entry a group's lone delegation chip spawned, linked exactly (parentToolCallId). */
function linkedDelegationSubagent(
  tools: readonly ToolCallState[],
  roster: readonly SubagentInfo[] | undefined,
): SubagentInfo | undefined {
  if (tools.length !== 1 || !subagentToolInfo(tools[0])) return undefined;
  const linked = subagentsForTool(tools[0], roster);
  return linked.length === 1 && linked[0].parentToolCallId === tools[0].id ? linked[0] : undefined;
}

/** A lone linked delegation's agent as its conversation presents it. */
export interface DelegationStatusLabel {
  /** The status word its SubagentSummaryLine shows, for summarizeToolsBase. */
  label: string;
  tone: SubagentTone;
}

/**
 * The status for a tool group whose one tool is a subagent delegation
 * linked to its roster entry: the agent as its conversation presents it
 * (copies folded across turns, liveness), as its SubagentSummaryLine
 * shows it. A background agent reads "in background", not its launch
 * receipt's "completed"; "stopped" once no live process tracks it; a later
 * turn's outcome once that arrives.
 *
 * The word labels the collapsed group; the tone keeps the group chrome in
 * agreement with it (withConversationTone): the failure fragment, and
 * running chrome only while the tool's own copy runs too.
 *
 * Undefined, which leaves the tool status's word and chrome, without a
 * conversation (specimens, provider-free tests), for any other group, or
 * when the conversation does not hold the agent. Subscribes like
 * useConversationSubagent: only that agent's changes re-render, and the
 * result keeps its identity while the tone stands.
 */
export function useDelegationStatusLabel(
  tools: readonly ToolCallState[],
  roster: readonly SubagentInfo[] | undefined,
): DelegationStatusLabel | undefined {
  const nodeId = useBackgroundWorkNodeId();
  const linked = linkedDelegationSubagent(tools, roster);
  const conversation = useConversationSubagent(nodeId, linked?.sessionId);
  let tone: SubagentTone | undefined;
  if (linked && conversation) {
    const shown = shownSubagent(linked, conversation);
    tone = subagentTone(shown.subagent ?? linked, shown.active);
  }
  return useMemo(() => (tone ? { label: SUBAGENT_TONE_LABEL[tone], tone } : undefined), [tone]);
}
