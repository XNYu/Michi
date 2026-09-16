import { PaneInspectionError, stripTurnMetadataSentinels, type AgentRunEventV1, type OutputPreview } from 'michi-shared';
import type { AgentRunsRepository } from './agentRunsRepository';
import { getDb } from './db';
import { buildOutputPreview } from './paneInspectionProjection.chat';

/** Read through the captured watermark, never the repository's first-page limit. */
export function readRunEventsThrough(
  repository: AgentRunsRepository, ownerUserId: string, runId: string, watermark: number,
): AgentRunEventV1[] {
  const events: AgentRunEventV1[] = [];
  let afterSeq = -1;
  while (afterSeq < watermark) {
    const page = repository.listEvents(ownerUserId, runId, afterSeq, 1000)
      .filter((event) => event.seq <= watermark);
    if (!page.length || page[page.length - 1].seq <= afterSeq) {
      throw new PaneInspectionError('SOURCE_UNAVAILABLE', 'events', 'run event history is incomplete at the captured watermark');
    }
    events.push(...page);
    afterSeq = page[page.length - 1].seq;
  }
  return events;
}

/** Called only after node authorization. Read visible assistant content, not tool/thought blocks. */
export function persistedChatPreview(nodeId: string, turnId?: string): OutputPreview | null {
  const rows = getDb().prepare(`
    SELECT m.id, m.content, m.created_at, t.turn_id, t.status, t.completed_at, t.checkpoint_at, t.started_at
    FROM messages m LEFT JOIN turns t ON t.node_id = m.node_id AND t.assistant_message_id = m.id
    WHERE m.node_id = ? AND m.role = 'assistant' AND m.content != ''
      ${turnId ? 'AND t.turn_id = ?' : ''}
    ORDER BY m.seq DESC`).iterate(...(turnId ? [nodeId, turnId] : [nodeId]));
  for (const raw of rows) {
    const row = raw as unknown as { id: string; content: string; created_at: number; turn_id: string | null;
      status: string | null; completed_at: number | null; checkpoint_at: number | null; started_at: number | null };
    const text = stripTurnMetadataSentinels(row.content);
    if (!text) continue;
    const preview = buildOutputPreview(text, row.turn_id ? { kind: 'chat_turn', nodeId, turnId: row.turn_id } : null,
      row.completed_at ?? row.checkpoint_at ?? row.started_at ?? row.created_at, row.status === 'active');
    if (!row.turn_id) preview.outputId = `chat-message:${row.id}`;
    return preview;
  }
  return null;
}
