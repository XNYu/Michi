import { useCallback } from 'react';
import { shallowArrayEqual, useNodesSelector } from '../../../state/chatStore';
import type { ChatNodeState } from '../../../state/chatTypes';
import { countActiveSubagents, type RunningWorkCounts } from '../../../state/backgroundWork';
import { useActiveWorkflowCounts, useBackgroundSubagentLiveness } from '../../../state/workflowDomain';

const IDLE: RunningWorkCounts = { subagents: 0, workflows: 0 };

/**
 * Running background work per open pane, for the pane-title badges. Chat
 * panes only; other pane items count nothing. A background agent no live
 * process tracks any more does not count (countActiveSubagents).
 *
 * Subagent roster updates are HIGH_FREQ actions the structural channel
 * ignores, so this reads every committed nodes map (useNodesSelector) and
 * returns the same arrays until a count changes: stream chunks do not
 * re-render the caller.
 */
export function usePaneBackgroundWorkCounts(
  paneIds: readonly string[],
  paneItems: Readonly<Record<string, unknown>>,
): (index: number) => RunningWorkCounts {
  const liveness = useBackgroundSubagentLiveness();
  const selectSubagentCounts = useCallback(
    (nodes: Record<string, ChatNodeState>) => paneIds.map((id) => {
      const node = nodes[id];
      return paneItems[id] || node?.kind !== 'chat' ? 0 : countActiveSubagents(node, liveness(node.projectId, node.nodeId));
    }),
    [paneIds, paneItems, liveness],
  );
  const subagents: readonly number[] | undefined = useNodesSelector(selectSubagentCounts, shallowArrayEqual);
  const workflows = useActiveWorkflowCounts(paneIds);
  return useCallback((index: number) => {
    const id = paneIds[index];
    if (id === undefined || paneItems[id]) return IDLE;
    const counts = { subagents: subagents?.[index] ?? 0, workflows: workflows[index] ?? 0 };
    return counts.subagents === 0 && counts.workflows === 0 ? IDLE : counts;
  }, [paneIds, paneItems, subagents, workflows]);
}
