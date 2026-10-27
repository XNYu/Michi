import {
  clampWorkflowText,
  isWorkflowRunTerminal,
  WORKFLOW_LIMITS,
  type WorkflowLogEntry,
  type WorkflowNodeDto,
  type WorkflowNodeStatus,
  type WorkflowRunDtoV1,
  type WorkflowRunStatus,
  type WorkflowUsage,
} from 'michi-shared';

/**
 * Claude Code dynamic workflows (the `Workflow` tool) as `system` task
 * frames with `task_type: 'local_workflow'`:
 *
 *   task_started   { task_id, tool_use_id, workflow_name, description, prompt (script) }
 *   task_progress  { usage, description, workflow_progress?: snapshot of
 *                    workflow_phase / workflow_agent items }
 *   task_updated   { patch: { status, end_time, error } }
 *   task_notification { status, summary, usage, output_file }
 *
 * `workflow_progress` is a full snapshot each time it is present, so the
 * node list is rebuilt from it. Pure functions; the tap owns I/O.
 */

type Envelope = Record<string, unknown>;

function rec(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function isClaudeWorkflowStart(env: Envelope): boolean {
  return env['type'] === 'system' && env['subtype'] === 'task_started' && env['task_type'] === 'local_workflow';
}

export function claudeTaskId(env: Envelope): string | undefined {
  return env['type'] === 'system' && typeof env['subtype'] === 'string' && (env['subtype'] as string).startsWith('task_')
    ? str(env['task_id'])
    : undefined;
}

function usageFrom(raw: Record<string, unknown> | undefined): WorkflowUsage | undefined {
  if (!raw) return undefined;
  const usage: WorkflowUsage = {};
  const tokens = num(raw['total_tokens']);
  const tools = num(raw['tool_uses']);
  const duration = num(raw['duration_ms']);
  if (tokens !== undefined) usage.totalTokens = tokens;
  if (tools !== undefined) usage.toolUses = tools;
  if (duration !== undefined) usage.durationMs = duration;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function agentStatus(state: string | undefined, startedAt: number | undefined): WorkflowNodeStatus {
  switch (state) {
    case 'done':
    case 'completed':
      return 'completed';
    case 'error':
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'killed':
    case 'stopped':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
    default:
      return startedAt !== undefined || state === 'start' || state === 'running' ? 'running' : 'queued';
  }
}

function phaseStatus(children: readonly WorkflowNodeDto[]): WorkflowNodeStatus {
  if (children.length === 0) return 'queued';
  if (children.some((child) => child.status === 'running')) return 'running';
  if (children.every((child) => child.status === 'completed' || child.status === 'skipped')) return 'completed';
  if (children.some((child) => child.status === 'failed')) return 'failed';
  if (children.some((child) => child.status === 'cancelled')) return 'cancelled';
  return 'running';
}

/** Rebuild the node list from a `workflow_progress` snapshot. */
export function claudeWorkflowNodes(progress: unknown, now: number): WorkflowNodeDto[] {
  if (!Array.isArray(progress)) return [];
  const phases: WorkflowNodeDto[] = [];
  const agents: WorkflowNodeDto[] = [];
  for (const raw of progress) {
    const item = rec(raw);
    if (!item) continue;
    const index = num(item['index']);
    if (index === undefined) continue;
    if (item['type'] === 'workflow_phase') {
      phases.push({ id: `phase:${index}`, kind: 'phase', title: clampWorkflowText(item['title'], WORKFLOW_LIMITS.title) ?? `Phase ${index}`, status: 'queued' });
    } else if (item['type'] === 'workflow_agent') {
      const startedAt = num(item['startedAt']);
      const status = agentStatus(str(item['state']), startedAt);
      const durationMs = num(item['durationMs']);
      const tool = str(item['lastToolName']);
      const toolSummary = str(item['lastToolSummary']);
      const usage: WorkflowUsage = {};
      if (num(item['tokens']) !== undefined) usage.totalTokens = num(item['tokens']);
      if (num(item['toolCalls']) !== undefined) usage.toolUses = num(item['toolCalls']);
      if (durationMs !== undefined) usage.durationMs = durationMs;
      const phaseIndex = num(item['phaseIndex']);
      const node: WorkflowNodeDto = {
        id: `agent:${index}`,
        kind: 'agent',
        title: clampWorkflowText(item['label'], WORKFLOW_LIMITS.title) ?? `Agent ${index}`,
        status,
        ...(phaseIndex !== undefined ? { parentId: `phase:${phaseIndex}` } : {}),
        ...(str(item['model']) ? { model: str(item['model']) } : {}),
        ...(num(item['attempt']) !== undefined ? { attempt: num(item['attempt']) } : {}),
        ...(clampWorkflowText(item['promptPreview'], WORKFLOW_LIMITS.prompt) ? { prompt: clampWorkflowText(item['promptPreview'], WORKFLOW_LIMITS.prompt) } : {}),
        ...(status === 'running' && tool ? { currentTool: clampWorkflowText(toolSummary ? `${tool} ${toolSummary}` : tool, WORKFLOW_LIMITS.line) } : {}),
        ...(clampWorkflowText(item['resultPreview'], WORKFLOW_LIMITS.result) ? { result: clampWorkflowText(item['resultPreview'], WORKFLOW_LIMITS.result) } : {}),
        ...(clampWorkflowText(item['error'], WORKFLOW_LIMITS.error) ? { error: clampWorkflowText(item['error'], WORKFLOW_LIMITS.error) } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(status !== 'running' && status !== 'queued' && startedAt !== undefined
          ? { endedAt: durationMs !== undefined ? startedAt + durationMs : now }
          : {}),
        ...(Object.keys(usage).length > 0 ? { usage } : {}),
        ...(usage.toolUses !== undefined ? { toolCount: usage.toolUses } : {}),
      };
      agents.push(node);
    }
  }
  // A phase mentioned only by its agents still gets a node.
  for (const agent of agents) {
    if (agent.parentId && !phases.some((phase) => phase.id === agent.parentId)) {
      phases.push({ id: agent.parentId, kind: 'phase', title: agent.parentId.replace('phase:', 'Phase '), status: 'queued' });
    }
  }
  const nodes: WorkflowNodeDto[] = [];
  for (const phase of phases.sort((a, b) => Number(a.id.slice(6)) - Number(b.id.slice(6)))) {
    const children = agents.filter((agent) => agent.parentId === phase.id);
    nodes.push({ ...phase, status: phaseStatus(children) }, ...children);
  }
  nodes.push(...agents.filter((agent) => !agent.parentId));
  return nodes.slice(0, WORKFLOW_LIMITS.nodes);
}

function terminalStatus(raw: string | undefined): WorkflowRunStatus | undefined {
  if (raw === 'completed') return 'completed';
  if (raw === 'failed') return 'failed';
  if (raw === 'killed' || raw === 'stopped' || raw === 'cancelled') return 'cancelled';
  return undefined;
}

/** Close nodes still open when the run ends. */
function closeNodes(nodes: readonly WorkflowNodeDto[], status: WorkflowRunStatus, now: number): WorkflowNodeDto[] {
  const closed: WorkflowNodeStatus = status === 'completed' ? 'completed' : 'cancelled';
  return nodes.map((node) => node.status === 'running' || (node.status === 'queued' && status !== 'completed')
    ? { ...node, status: node.status === 'queued' ? 'skipped' : closed, currentTool: undefined, endedAt: node.endedAt ?? now }
    : node);
}

export function appendWorkflowLog(log: readonly WorkflowLogEntry[], entry: WorkflowLogEntry): WorkflowLogEntry[] {
  const last = log[log.length - 1];
  if (last && last.text === entry.text && last.nodeId === entry.nodeId) return [...log];
  return [...log, entry].slice(-WORKFLOW_LIMITS.log);
}

/** Seed fields from task_started. */
export function claudeWorkflowSeed(env: Envelope): Partial<WorkflowRunDtoV1> {
  const description = clampWorkflowText(env['description'], WORKFLOW_LIMITS.line);
  return {
    name: clampWorkflowText(env['workflow_name'], WORKFLOW_LIMITS.title) ?? description ?? 'Workflow',
    ...(description ? { description } : {}),
    ...(clampWorkflowText(env['prompt'], WORKFLOW_LIMITS.definition) ? { definition: clampWorkflowText(env['prompt'], WORKFLOW_LIMITS.definition) } : {}),
    parentToolCallId: str(env['tool_use_id']) ?? null,
  };
}

/** Fold one task frame of a tracked workflow into its run. */
export function applyClaudeWorkflowEnvelope(run: WorkflowRunDtoV1, env: Envelope, now: number): WorkflowRunDtoV1 {
  const subtype = str(env['subtype']);
  if (subtype === 'task_started') return { ...run, ...claudeWorkflowSeed(env), status: 'running' };
  if (isWorkflowRunTerminal(run.status) && subtype !== 'task_notification') return run;
  if (subtype === 'task_progress') {
    const usage = usageFrom(rec(env['usage']));
    const progress = env['workflow_progress'];
    return {
      ...run,
      ...(usage ? { usage: { ...run.usage, ...usage } } : {}),
      ...(Array.isArray(progress) ? { nodes: claudeWorkflowNodes(progress, now) } : {}),
      ...(clampWorkflowText(env['description'], WORKFLOW_LIMITS.line) && run.status === 'running'
        ? { statusDetail: clampWorkflowText(env['description'], WORKFLOW_LIMITS.line) }
        : {}),
    };
  }
  if (subtype === 'task_updated') {
    const patch = rec(env['patch']);
    const status = terminalStatus(str(patch?.['status']));
    if (!status) return run;
    const endedAt = num(patch?.['end_time']) ?? now;
    const error = clampWorkflowText(patch?.['error'], WORKFLOW_LIMITS.line);
    return {
      ...run,
      status,
      endedAt: run.endedAt ?? endedAt,
      nodes: closeNodes(run.nodes, status, endedAt),
      ...(error ? { statusDetail: error } : {}),
    };
  }
  if (subtype === 'task_notification') {
    const status = terminalStatus(str(env['status'])) ?? run.status;
    const summary = clampWorkflowText(env['summary'], WORKFLOW_LIMITS.line);
    const usage = usageFrom(rec(env['usage']));
    const endedAt = run.endedAt ?? now;
    // The summary restates the workflow's description; on a stop or failure
    // it must not replace the reason already recorded.
    const keepDetail = status !== 'completed' && isWorkflowRunTerminal(run.status) && !!run.statusDetail;
    return {
      ...run,
      status,
      endedAt,
      nodes: isWorkflowRunTerminal(status) ? closeNodes(run.nodes, status, endedAt) : run.nodes,
      ...(summary && !keepDetail ? { statusDetail: summary } : {}),
      ...(usage ? { usage: { ...run.usage, ...usage } } : {}),
    };
  }
  return run;
}

/**
 * The `.output` file written when the workflow ends:
 * `{ summary, agentCount, logs, result, workflowProgress }`.
 */
export function applyClaudeWorkflowOutput(run: WorkflowRunDtoV1, output: unknown, now: number): WorkflowRunDtoV1 {
  const raw = rec(output);
  if (!raw) return run;
  const resultValue = raw['result'];
  const result = typeof resultValue === 'string'
    ? clampWorkflowText(resultValue, WORKFLOW_LIMITS.result)
    : resultValue !== undefined && resultValue !== null
      ? clampWorkflowText(JSON.stringify(resultValue, null, 2), WORKFLOW_LIMITS.result)
      : undefined;
  let log = run.log;
  if (Array.isArray(raw['logs'])) {
    for (const line of raw['logs'] as unknown[]) {
      const text = clampWorkflowText(typeof line === 'string' ? line : rec(line)?.['message'], WORKFLOW_LIMITS.line);
      if (text) log = appendWorkflowLog(log, { at: now, text });
    }
  }
  const nodes = Array.isArray(raw['workflowProgress'])
    ? closeNodes(claudeWorkflowNodes(raw['workflowProgress'], now), run.status, run.endedAt ?? now)
    : run.nodes;
  return { ...run, ...(result ? { result } : {}), log, nodes: nodes.length > 0 ? nodes : run.nodes };
}

/**
 * A CLI `control_response` (reply to a control_request Michi wrote):
 * `{ type: 'control_response', response: { subtype: 'success' | 'error', request_id, error? } }`.
 */
export function claudeControlResponse(env: Envelope): { requestId: string; ok: boolean; error?: string } | null {
  if (env['type'] !== 'control_response') return null;
  const response = rec(env['response']);
  const requestId = str(response?.['request_id']);
  if (!requestId) return null;
  const ok = response?.['subtype'] !== 'error';
  return { requestId, ok, ...(ok ? {} : { error: str(response?.['error']) ?? 'Claude rejected the request' }) };
}
