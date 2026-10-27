import type {
  WorkflowAction,
  WorkflowNodeDto,
  WorkflowNodeStatus,
  WorkflowRunDtoV1,
  WorkflowRunStatus,
} from 'michi-shared';
import { formatDurationMs } from '../toolCallGrouping';

/** Run status colors follow AgentRunCard (completed reads as digest). */
export const WORKFLOW_STATUS_COLOR: Record<WorkflowRunStatus, string> = {
  running: 'var(--term-accent)',
  paused: 'var(--term-select)',
  completed: 'var(--term-digest)',
  failed: 'var(--term-danger)',
  cancelled: 'var(--term-muted)',
};

export const WORKFLOW_STATUS_LABEL: Record<WorkflowRunStatus, string> = {
  running: 'running',
  paused: 'paused',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'stopped',
};

export const NODE_STATUS_COLOR: Record<WorkflowNodeStatus, string> = {
  queued: 'var(--term-faint)',
  running: 'var(--term-accent)',
  paused: 'var(--term-select)',
  completed: 'var(--term-muted)',
  failed: 'var(--term-danger)',
  cancelled: 'var(--term-muted)',
  skipped: 'var(--term-faint)',
};

export const NODE_STATUS_LABEL: Record<WorkflowNodeStatus, string> = {
  queued: 'queued',
  running: 'running',
  paused: 'paused',
  completed: 'done',
  failed: 'failed',
  cancelled: 'stopped',
  skipped: 'skipped',
};

export const ACTION_LABEL: Record<WorkflowAction, string> = {
  stop: 'Stop',
  pause: 'Pause',
  resume: 'Resume',
  retry: 'Retry',
};

export const RUNTIME_LABEL: Record<WorkflowRunDtoV1['runtime'], string> = {
  claude: 'Claude Code',
  kiro: 'Kiro CLI',
};

export function workflowElapsedMs(run: Pick<WorkflowRunDtoV1, 'startedAt' | 'endedAt' | 'status'>, now = Date.now()): number {
  const end = run.endedAt ?? (run.status === 'running' || run.status === 'paused' ? now : run.startedAt);
  return Math.max(0, end - run.startedAt);
}

export function workflowElapsedLabel(run: Pick<WorkflowRunDtoV1, 'startedAt' | 'endedAt' | 'status'>, now = Date.now()): string {
  return formatDurationMs(workflowElapsedMs(run, now));
}

export function nodeDurationMs(node: WorkflowNodeDto, now = Date.now()): number | undefined {
  if (node.usage?.durationMs !== undefined) return node.usage.durationMs;
  if (node.startedAt === undefined) return undefined;
  const end = node.endedAt ?? (node.status === 'running' ? now : undefined);
  return end !== undefined && end >= node.startedAt ? end - node.startedAt : undefined;
}

/** Nodes in tree order with their depth (parents precede children). */
export function workflowNodeRows(nodes: readonly WorkflowNodeDto[]): Array<{ node: WorkflowNodeDto; depth: number }> {
  const byParent = new Map<string | undefined, WorkflowNodeDto[]>();
  const ids = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    const parent = node.parentId && ids.has(node.parentId) ? node.parentId : undefined;
    const list = byParent.get(parent) ?? [];
    list.push(node);
    byParent.set(parent, list);
  }
  const rows: Array<{ node: WorkflowNodeDto; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (parent: string | undefined, depth: number) => {
    for (const node of byParent.get(parent) ?? []) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      rows.push({ node, depth });
      walk(node.id, depth + 1);
    }
  };
  walk(undefined, 0);
  return rows;
}

/** The one line that says what the run is doing right now. */
export function workflowNowLine(run: WorkflowRunDtoV1): string | undefined {
  if (run.status !== 'running' && run.status !== 'paused') return undefined;
  if (run.status === 'paused') return run.statusDetail;
  const active = run.nodes.filter((node) => node.status === 'running' && (node.kind === 'agent' || node.kind === 'step'));
  if (active.length === 1) {
    const [node] = active;
    return node.currentTool ? `${node.title} ❯ ${node.currentTool}` : node.statusMessage ? `${node.title} · ${node.statusMessage}` : node.title;
  }
  if (active.length > 1) return `${active.length} agents: ${active.map((node) => node.title).join(', ')}`;
  return run.log.at(-1)?.text ?? run.statusDetail;
}

export function formatWorkflowTokens(tokens: number | undefined): string | undefined {
  if (tokens === undefined || tokens <= 0) return undefined;
  if (tokens < 1_000) return `${tokens} tokens`;
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k tokens`;
  return `${(tokens / 1_000_000).toFixed(1)}M tokens`;
}
