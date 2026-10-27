import {
  clampSubagentText,
  SUBAGENT_LIMITS,
  type SubagentActivityPayload,
  type SubagentInfo,
} from 'michi-shared';
import { createSubtaskNarration } from '../../kiro/kiroSubagents';
import type { CrewEvent } from './gatewayTypes';

/**
 * Folds the official Crew gateway subagent frames for one parent slot into
 * Michi roster patches and activity.
 *
 * Shapes (kiro_crew subagent_manager / dashboard.ws):
 *   subagent_spawn    {id, slot, task, agent, model, requested_model, child_session}
 *   subagent_snapshot {id, slot, task, agent, model, streaming, last_tool, tool_count, stalled}
 *   subagent_tool     {id, slot, tool, tool_kind, turns, tool_count}   (at dispatch)
 *   subagent_chunk    {id, slot, text}
 *   subagent_done     {id, slot, elapsed, error, stopped, outcome, task, agent, model, result, stop_reason, partial}
 *
 * `subagent_tool` fires when a tool is dispatched and has no completion edge,
 * so a newer tool (or the end of the run) closes the previous one.
 */

export type CrewSubagentUpdate =
  | { kind: 'roster'; entry: SubagentInfo }
  | { kind: 'activity'; activity: SubagentActivityPayload };

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function createCrewSubagentFold(now: () => number = Date.now) {
  const known = new Set<string>();
  const lastTool = new Map<string, { id: string; title: string; toolKind?: string }>();
  const narration = createSubtaskNarration();
  const toolSeq = new Map<string, number>();

  function entry(id: string, data: Record<string, unknown>, patch: Partial<SubagentInfo>): SubagentInfo {
    const task = str(data['task']);
    const agent = str(data['agent']);
    return {
      sessionId: id,
      sessionName: agent ?? '',
      agentName: agent ?? '',
      initialQuery: task ? oneLine(task.split('\n')[0], 200) : '',
      status: 'working',
      group: '',
      dependsOn: [],
      source: 'crew',
      ...(task ? { prompt: clampSubagentText(task, SUBAGENT_LIMITS.prompt) } : {}),
      ...(str(data['model']) ? { model: str(data['model']) } : {}),
      ...patch,
    };
  }

  function closeTool(id: string, status: 'completed' | 'interrupted'): SubagentActivityPayload | null {
    const previous = lastTool.get(id);
    if (!previous) return null;
    lastTool.delete(id);
    return { subagentSessionId: id, toolCallId: previous.id, title: previous.title, status, ...(previous.toolKind ? { toolKind: previous.toolKind } : {}) };
  }

  return {
    /** Fold one gateway frame. Frames for other slots must be filtered first. */
    apply(event: CrewEvent): CrewSubagentUpdate[] {
      const data = event.data;
      const id = str(data['id']);
      if (!id) return [];
      const out: CrewSubagentUpdate[] = [];
      const seen = known.has(id);
      if (event.type === 'subagent_spawn' || event.type === 'subagent_snapshot') {
        known.add(id);
        const patch: Partial<SubagentInfo> = seen ? {} : { startedAt: now() };
        const lastToolName = str(data['last_tool']);
        if (lastToolName && event.type === 'subagent_snapshot') patch.statusMessage = oneLine(lastToolName, SUBAGENT_LIMITS.statusMessage);
        const toolCount = typeof data['tool_count'] === 'number' ? data['tool_count'] as number : undefined;
        if (toolCount !== undefined) patch.usage = { toolUses: toolCount };
        out.push({ kind: 'roster', entry: entry(id, data, patch) });
        return out;
      }
      if (!seen) {
        // A frame for a child this turn never saw spawn (reconnect gap):
        // register it before its activity so the fold has a row.
        known.add(id);
        out.push({ kind: 'roster', entry: entry(id, data, { startedAt: now() }) });
      }
      if (event.type === 'subagent_tool') {
        const pending = narration.boundary(id);
        if (pending) out.push({ kind: 'activity', activity: pending });
        const closed = closeTool(id, 'completed');
        if (closed) out.push({ kind: 'activity', activity: closed });
        const title = oneLine(str(data['tool']) ?? 'tool', SUBAGENT_LIMITS.title);
        // Ids come from our own per-agent counter: tool_count is optional and
        // a gateway that omits it must not collapse every tool into one row.
        const count = (toolSeq.get(id) ?? 0) + 1;
        toolSeq.set(id, count);
        const toolKind = str(data['tool_kind']);
        const toolCallId = `${id}:t:${count}`;
        lastTool.set(id, { id: toolCallId, title, ...(toolKind ? { toolKind } : {}) });
        out.push({ kind: 'activity', activity: { subagentSessionId: id, toolCallId, title, status: 'in_progress', ...(toolKind ? { toolKind } : {}) } });
        return out;
      }
      if (event.type === 'subagent_chunk') {
        const text = typeof data['text'] === 'string' ? data['text'] : '';
        if (text) for (const activity of narration.push(id, undefined, text)) out.push({ kind: 'activity', activity });
        return out;
      }
      if (event.type === 'subagent_done') {
        const pending = narration.boundary(id);
        if (pending) out.push({ kind: 'activity', activity: pending });
        const stopped = data['stopped'] === true;
        const error = str(data['error']);
        const closed = closeTool(id, stopped || error ? 'interrupted' : 'completed');
        if (closed) out.push({ kind: 'activity', activity: closed });
        const elapsed = typeof data['elapsed'] === 'number' && Number.isFinite(data['elapsed']) ? data['elapsed'] as number : undefined;
        const result = str(data['result']);
        out.push({ kind: 'roster', entry: entry(id, data, {
          status: 'terminated',
          outcome: stopped ? 'cancelled' : error ? 'failed' : 'completed',
          endedAt: now(),
          ...(error ? { error: clampSubagentText(error, SUBAGENT_LIMITS.error) } : {}),
          ...(result ? { result: clampSubagentText(result, SUBAGENT_LIMITS.result) } : {}),
          ...(elapsed !== undefined ? { usage: { durationMs: Math.round(elapsed * 1000) } } : {}),
        }) });
        return out;
      }
      return out;
    },
  };
}
