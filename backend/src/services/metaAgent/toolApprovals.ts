import { createHash } from 'node:crypto';
import type { MetaAgentToolApproval } from 'michi-shared';
import { getDb } from '../db';
import type { McpServerConfig, McpToolInfo } from '../mcpClientManager';
import { metaAgentGuardOwnerKey } from './guardStatus';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const key = (owner?: string | null) => `meta_agent_tool_approvals:${metaAgentGuardOwnerKey(owner)}`;
// Only the hash is stored: connection credentials and invocation arguments never enter the approval record.
export function toolApprovalId(config: McpServerConfig, tool: McpToolInfo): string {
  return createHash('sha256').update(stable({ config, tool })).digest('hex');
}
export function listToolApprovals(owner?: string | null): MetaAgentToolApproval[] {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key(owner)) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : [];
}
function save(records: MetaAgentToolApproval[], owner?: string | null): void {
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key(owner), JSON.stringify(records));
}
export function getToolApproval(config: McpServerConfig, tool: McpToolInfo, owner?: string | null): MetaAgentToolApproval | undefined {
  return listToolApprovals(owner).find(r => r.id === toolApprovalId(config, tool));
}
export function requestToolApproval(config: McpServerConfig, tool: McpToolInfo, owner?: string | null): MetaAgentToolApproval | null {
  const records = listToolApprovals(owner);
  const id = toolApprovalId(config, tool);
  const existing = records.find(r => r.id === id);
  if (existing) return existing;
  if (records.length >= 500) return null;
  const record: MetaAgentToolApproval = {
    id, server: config.serverName, tool: tool.name, description: tool.description?.slice(0, 2000) ?? '',
    state: 'pending', requestedAt: Date.now(), updatedAt: Date.now(),
  };
  records.push(record); save(records, owner); return record;
}
/** Human settings route only. Never register this operation in an agent's tool catalog. */
export function decideToolApproval(id: string, state: 'approved' | 'denied' | 'revoked', owner?: string | null): boolean {
  const records = listToolApprovals(owner);
  const record = records.find(r => r.id === id);
  if (!record) return false;
  record.state = state; record.updatedAt = Date.now(); save(records, owner); return true;
}
