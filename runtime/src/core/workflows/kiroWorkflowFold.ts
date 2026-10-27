import {
  clampWorkflowText,
  isWorkflowRunTerminal,
  WORKFLOW_LIMITS,
  type WorkflowNodeDto,
  type WorkflowNodeKind,
  type WorkflowNodeStatus,
  type WorkflowRunDtoV1,
  type WorkflowRunStatus,
} from 'michi-shared';
import { appendWorkflowLog } from './claudeWorkflowFold';

/**
 * Kiro CLI V3 workflows. Notifications (no request id):
 *
 *   _kiro/workflow/run_start      { workflowId, workflowName, inputs, nodeTree, parentSessionId }
 *   _kiro/workflow/node_start     { workflowId, nodeId, nodePath, type, agentName, sessionId?, branchId?, iteration? }
 *   _kiro/workflow/node_complete  { workflowId, nodeId, status, capturedOutput?, failureReason? }
 *   _kiro/workflow/node_paused    { workflowId, nodeId, reason }
 *   _kiro/workflow/paused         { workflowId, pauseReason }
 *   _kiro/workflow/loop_iteration { workflowId, loopId, iteration, stopConditionMet }
 *   _kiro/workflow/run_complete   { workflowId, status, finalState }
 *   _kiro/session/notify          { workflowId, nodeId, message, severity, sender: 'step' }
 *
 * Step sessions also stream ordinary `session/update` frames tagged
 * `_meta.kiro.workflow { workflowId, nodeId }`; their tool calls become the
 * node's current tool. Pure functions; the bridge owns routing.
 */

type Params = Record<string, unknown>;

function rec(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const KINDS: Record<string, WorkflowNodeKind> = {
  step: 'step', agent: 'step', parallel: 'parallel', loop: 'loop', branch: 'branch', conditional: 'branch', group: 'group', sequence: 'group',
};
const CHILD_KEYS = ['branches', 'children', 'steps', 'body', 'nodes'];

function nodeKind(type: unknown): WorkflowNodeKind {
  return (typeof type === 'string' && KINDS[type]) || 'step';
}

function nodeStatus(raw: string | undefined): WorkflowNodeStatus {
  switch (raw) {
    case 'completed':
    case 'success':
    case 'succeeded':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'skipped':
      return 'skipped';
    // Kiro's terminal status for a stopped run or node is `aborted`.
    case 'aborted':
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'paused':
      return 'paused';
    case 'pending':
      return 'queued';
    case 'running':
      return 'running';
    default:
      return 'completed';
  }
}

/** Kiro run statuses: running | paused | completed | failed | aborted. */
function runStatus(raw: string | undefined): WorkflowRunStatus {
  if (raw === 'failed' || raw === 'error') return 'failed';
  if (raw === 'aborted' || raw === 'cancelled' || raw === 'canceled') return 'cancelled';
  if (raw === 'paused') return 'paused';
  if (raw === 'running') return 'running';
  return 'completed';
}

/** Flatten the static node tree, parents before children. */
export function kiroWorkflowNodes(tree: unknown): WorkflowNodeDto[] {
  const nodes: WorkflowNodeDto[] = [];
  const walk = (items: unknown, parentId?: string) => {
    if (!Array.isArray(items)) return;
    for (const raw of items) {
      const item = rec(raw);
      const id = str(item?.['nodeId']);
      if (!item || !id || nodes.length >= WORKFLOW_LIMITS.nodes) continue;
      nodes.push({
        id,
        kind: nodeKind(item['type']),
        title: clampWorkflowText(item['name'], WORKFLOW_LIMITS.title) ?? id,
        status: 'queued',
        ...(parentId ? { parentId } : {}),
        ...(str(item['agentName']) ? { agentName: str(item['agentName']) } : {}),
      });
      for (const key of CHILD_KEYS) walk(item[key], id);
    }
  };
  walk(tree);
  return nodes;
}

function updateNode(
  run: WorkflowRunDtoV1,
  nodeId: string,
  patch: (node: WorkflowNodeDto) => WorkflowNodeDto,
  create?: () => WorkflowNodeDto,
): WorkflowRunDtoV1 {
  const index = run.nodes.findIndex((node) => node.id === nodeId);
  if (index >= 0) {
    const nodes = [...run.nodes];
    nodes[index] = patch(nodes[index]);
    return { ...run, nodes };
  }
  if (!create || run.nodes.length >= WORKFLOW_LIMITS.nodes) return run;
  return { ...run, nodes: [...run.nodes, patch(create())] };
}

function parentFromPath(path: unknown, workflowId: string): string | undefined {
  if (!Array.isArray(path) || path.length < 2) return undefined;
  const parent = path[path.length - 2];
  return typeof parent === 'string' && parent !== workflowId ? parent : undefined;
}

/** The workflow a notification or tagged step update belongs to. */
export function kiroWorkflowId(params: Params): string | undefined {
  const direct = str(params['workflowId']);
  if (direct) return direct;
  const workflow = rec(rec(rec(rec(params['update'])?.['_meta'])?.['kiro'])?.['workflow']);
  return str(workflow?.['workflowId']);
}

/** Fold one `_kiro/workflow/*` or `_kiro/session/notify` notification. */
export function applyKiroWorkflowNotification(run: WorkflowRunDtoV1, method: string, params: Params, now: number): WorkflowRunDtoV1 {
  const event = method.startsWith('_kiro/workflow/') ? method.slice('_kiro/workflow/'.length) : method;
  const nodeId = str(params['nodeId']);
  if (event === 'run_start') {
    // Also sent again on resume and retry: keep what the nodes already did.
    const inputs = params['inputs'];
    const definition = inputs !== undefined ? clampWorkflowText(JSON.stringify(inputs, null, 2), WORKFLOW_LIMITS.definition) : undefined;
    const tree = kiroWorkflowNodes(params['nodeTree']);
    const known = new Map(run.nodes.map((node) => [node.id, node]));
    const nodes = tree.length === 0 ? run.nodes : tree.map((node) => {
      const prior = known.get(node.id);
      return prior ? { ...prior, ...(prior.status === 'paused' ? { status: 'queued' as const } : {}) } : node;
    });
    const { endedAt: _endedAt, ...open } = run;
    return {
      ...open,
      name: clampWorkflowText(params['workflowName'], WORKFLOW_LIMITS.title) ?? run.name,
      ...(definition ? { definition } : {}),
      status: 'running',
      statusDetail: undefined,
      nodes,
    };
  }
  if (event === 'run_complete' && str(params['status']) === 'paused') {
    // A pause ends the run loop with status `paused`; the run is resumable.
    return { ...run, status: 'paused', statusDetail: run.statusDetail ?? 'Paused' };
  }
  if (event === 'run_complete') {
    const status = runStatus(str(params['status']));
    const finalState = rec(params['finalState']);
    const captured = rec(finalState?.['capturedOutputs']);
    let next: WorkflowRunDtoV1 = { ...run, status, endedAt: run.endedAt ?? now };
    if (captured) {
      for (const [id, output] of Object.entries(captured)) {
        const text = clampWorkflowText(typeof output === 'string' ? output : JSON.stringify(output), WORKFLOW_LIMITS.result);
        if (text) next = updateNode(next, id, (node) => node.result ? node : { ...node, result: text });
      }
    }
    const explicit = finalState?.['result'] ?? finalState?.['output'];
    const lastCompleted = [...next.nodes].reverse().find((node) => !node.parentId && node.result);
    const result = clampWorkflowText(typeof explicit === 'string' ? explicit : explicit !== undefined ? JSON.stringify(explicit, null, 2) : lastCompleted?.result, WORKFLOW_LIMITS.result);
    const failure = clampWorkflowText(finalState?.['failureReason'] ?? finalState?.['error'], WORKFLOW_LIMITS.line);
    const closed: WorkflowNodeStatus = status === 'completed' ? 'completed' : 'cancelled';
    return {
      ...next,
      ...(result ? { result } : {}),
      ...(failure ? { statusDetail: failure } : status === 'completed' ? { statusDetail: undefined } : {}),
      nodes: next.nodes.map((node) => node.status === 'running' || node.status === 'paused'
        ? { ...node, status: closed, currentTool: undefined, endedAt: node.endedAt ?? now }
        : node.status === 'queued' && status !== 'completed' ? { ...node, status: 'skipped' } : node),
    };
  }
  // Kiro keeps workflow state on disk; a run Michi marked interrupted (its
  // session or Michi went away) can be resumed by Kiro and start nodes again.
  if (event === 'node_start' && run.status === 'cancelled' && run.statusDetail?.startsWith('Interrupted')) {
    run = { ...run, status: 'running', statusDetail: undefined, endedAt: undefined };
  }
  if (isWorkflowRunTerminal(run.status)) return run;
  if (event === 'paused') {
    return { ...run, status: 'paused', statusDetail: clampWorkflowText(params['pauseReason'] ?? params['reason'], WORKFLOW_LIMITS.line) ?? 'Paused' };
  }
  if (!nodeId && event !== 'notify' && event !== '_kiro/session/notify') return run;
  if (event === 'node_start' && nodeId) {
    const resumed = run.status === 'paused' ? { status: 'running' as const, statusDetail: undefined } : {};
    return {
      ...updateNode(run, nodeId, (node) => ({
        ...node,
        status: 'running',
        startedAt: node.startedAt ?? now,
        ...(str(params['agentName']) ? { agentName: str(params['agentName']) } : {}),
        ...(num(params['iteration']) !== undefined ? { iteration: num(params['iteration']) } : {}),
      }), () => ({
        id: nodeId,
        kind: nodeKind(params['type']),
        title: nodeId,
        status: 'running',
        ...(parentFromPath(params['nodePath'], run.nativeId) ? { parentId: parentFromPath(params['nodePath'], run.nativeId) } : {}),
      })),
      ...resumed,
    };
  }
  if (event === 'node_complete' && nodeId) {
    const status = nodeStatus(str(params['status']));
    const result = clampWorkflowText(params['capturedOutput'], WORKFLOW_LIMITS.result);
    const error = clampWorkflowText(params['failureReason'], WORKFLOW_LIMITS.error);
    return updateNode(run, nodeId, (node) => ({
      ...node,
      status,
      currentTool: undefined,
      endedAt: now,
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
    }));
  }
  if (event === 'node_paused' && nodeId) {
    return updateNode(run, nodeId, (node) => ({ ...node, status: 'paused', statusMessage: clampWorkflowText(params['reason'], WORKFLOW_LIMITS.line) ?? node.statusMessage }));
  }
  if (event === 'loop_iteration') {
    const loopId = str(params['loopId']) ?? nodeId;
    const iteration = num(params['iteration']);
    if (!loopId || iteration === undefined) return run;
    return updateNode(run, loopId, (node) => ({ ...node, iteration, statusMessage: `Iteration ${iteration}${params['stopConditionMet'] === true ? ' · stop condition met' : ''}` }));
  }
  if (method === '_kiro/session/notify') {
    const text = clampWorkflowText(params['message'], WORKFLOW_LIMITS.line);
    if (!text) return run;
    const severity = str(params['severity']);
    const next: WorkflowRunDtoV1 = {
      ...run,
      log: appendWorkflowLog(run.log, {
        at: now,
        text,
        ...(nodeId ? { nodeId } : {}),
        ...(severity === 'info' || severity === 'success' || severity === 'warning' || severity === 'error' ? { severity } : {}),
      }),
    };
    return nodeId ? updateNode(next, nodeId, (node) => ({ ...node, statusMessage: text })) : next;
  }
  return run;
}

/** A step session's own `session/update` (tagged `_meta.kiro.workflow`). */
export function applyKiroStepUpdate(run: WorkflowRunDtoV1, params: Params, now: number): WorkflowRunDtoV1 {
  if (isWorkflowRunTerminal(run.status)) return run;
  const update = rec(params['update']);
  const workflow = rec(rec(rec(update?.['_meta'])?.['kiro'])?.['workflow']);
  const nodeId = str(workflow?.['nodeId']);
  const kind = str(update?.['sessionUpdate']);
  if (!update || !nodeId || (kind !== 'tool_call' && kind !== 'tool_call_update')) return run;
  const title = clampWorkflowText(update['title'], WORKFLOW_LIMITS.line);
  const status = str(update['status']);
  const running = !status || status === 'pending' || status === 'in_progress';
  return updateNode(run, nodeId, (node) => ({
    ...node,
    ...(kind === 'tool_call' ? { toolCount: (node.toolCount ?? 0) + 1 } : {}),
    ...(running && title ? { currentTool: title } : {}),
    ...(!running && (!title || node.currentTool === title) ? { currentTool: undefined } : {}),
    ...(node.status === 'queued' ? { status: 'running', startedAt: node.startedAt ?? now } : {}),
  }));
}
