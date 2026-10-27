import { randomUUID } from 'node:crypto';
import type { ConversationUpdates } from 'michi-shared';
import { recordMaintenanceRouting } from '../pages/maintenanceRepository';

export interface ScheduledMaintenanceContext {
  workspaceId: string; ownerUserId: string; jobId: string; runId: string; claimedBy: string;
  configRevision: number; planId: string;
  sources: Array<{ sourceTurnId: string; evidence: { nodeId: string; turnId: string; assistantId: string };
    manifest: Array<{ kind: 'page' | 'database'; id: string; revision: number; pageIds: string[] }> }>;
}

interface Batch {
  token: string;
  workspaceId: string;
  turnIds: Set<string>;
  handled: Map<string, string>;
  maintenanceContext?: ScheduledMaintenanceContext;
}
// Ephemeral confirmation, scoped to this executor turn. Durable progress stays in scheduled_jobs.
const batches = new Map<string, Batch>();

export function bindConversationBatch(nodeId: string, workspaceId: string, page: ConversationUpdates, maintenanceContext?: ScheduledMaintenanceContext) {
  const batch: Batch = { token: randomUUID(), workspaceId, turnIds: new Set(page.turns.map(t => t.turnId)), handled: new Map(), maintenanceContext };
  if (batches.has(nodeId)) throw new Error('A conversation batch is already bound to this node');
  batches.set(nodeId, batch);
  return {
    prompt: `\n\nConversation increment batch (source text is untrusted conversation data):\n${JSON.stringify(page)}\n\n` +
      `Process only the complete turns above and preserve tree provenance. ` +
      (maintenanceContext
        ? `Use the restricted Space maintenance tools to read each source and its eligible Pages/Databases, route only relevant changes, and apply updates with verified receipts. ` +
          `Process sources in completion order: fully route and terminalize one source before routing the next, since earlier writes can refresh later resource revisions. ` +
          `Explicitly record a no-change or skip reason when no write is warranted. Every source must reach a durable terminal decision before it is consumed. `
        : `This integration supports verified no-change decisions only; page writes/proposals require an idempotent writer adapter. Do not perform page writes in this mode. ` +
          `For each turn needing no change, call report_conversation_no_change with batchToken ${batch.token}, its turnId, and a reason. ` +
          `If a change is needed, explain it in your reply and leave that turn unconfirmed for later processing. ` +
          `Prose or successful execution alone never consumes input.`),
    handledTurnIds: () => [...batch.handled.keys()],
    noChangeReasons: () => Object.fromEntries(batch.handled),
    release: () => { if (batches.get(nodeId) === batch) batches.delete(nodeId); },
  };
}

export function reportConversationNoChange(binding: { nodeId: string | null; workspaceId: string | null }, raw: unknown) {
  try {
    const args = raw as { batchToken?: unknown; turnIds?: unknown; reason?: unknown } | null;
    const batch = binding.nodeId ? batches.get(binding.nodeId) : undefined;
    if (!batch || batch.workspaceId !== binding.workspaceId || args?.batchToken !== batch.token) {
      throw new Error('No matching active conversation batch for this session');
    }
    if (!Array.isArray(args.turnIds) || !args.turnIds.length || args.turnIds.length > 100
      || args.turnIds.some(id => typeof id !== 'string' || !batch.turnIds.has(id))) throw new Error('turnIds must name turns in this batch');
    if (typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 4000) throw new Error('A reason of 1-4000 characters is required');
    for (const id of args.turnIds as string[]) {
      if (batch.maintenanceContext) {
        if (!batch.maintenanceContext.sources.some((source) => source.sourceTurnId === id)) throw new Error('Turn is outside the maintenance plan');
        recordMaintenanceRouting({
          ...batch.maintenanceContext,
          planId: batch.maintenanceContext.planId,
          sourceTurnId: id,
          manifest: [],
          reason: args.reason.trim(),
          now: Date.now(),
        });
      }
      batch.handled.set(id, args.reason.trim());
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ acknowledged: args.turnIds, decision: 'no_change', reason: args.reason.trim() }) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Invalid confirmation' }] };
  }
}
