import { DEFAULT_CHAT_PERMISSION_SETTINGS, isChatPermissionMode, isChatPermissionSettings, type ChatPermissionMode, type ChatPermissionSettings } from 'michi-shared';
import { getDb } from './db';
import { getNode, getWorkspace } from './dbRepository';
import { readPrefs } from './prefsConfig';

function settingsKey(userId?: string | null): string {
  if (process.env.MICHI_CLOUD === '1') {
    if (!userId) throw new Error('Permission settings require an authenticated owner');
    return `chat_permissions:user:${userId}`;
  }
  return 'chat_permissions:desktop';
}

export function readChatPermissionSettings(userId?: string | null): ChatPermissionSettings {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(settingsKey(userId)) as { value: string } | undefined;
  if (row) {
    try {
      const value: unknown = JSON.parse(row.value);
      if (isChatPermissionSettings(value)) return value;
    } catch { /* Corrupt preferences fail closed. */ }
    return { ...DEFAULT_CHAT_PERMISSION_SETTINGS };
  }
  // The former desktop bypass switch auto-approved prompts, without disabling
  // native sandboxes. Migrate it to global Trust, once, in the durable store.
  const bypass = process.env.MICHI_CLOUD !== '1' && readPrefs()?.bypassPermissions === true;
  const settings: ChatPermissionSettings = bypass ? { global: true, mode: 'trust' } : { ...DEFAULT_CHAT_PERMISSION_SETTINGS };
  writeChatPermissionSettings(settings, userId);
  return settings;
}

export function writeChatPermissionSettings(settings: ChatPermissionSettings, userId?: string | null): void {
  if (!isChatPermissionSettings(settings)) throw new Error('Invalid permission settings');
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(settingsKey(userId), JSON.stringify({ global: settings.global, mode: settings.mode }));
  if (settings.mode === 'ask') {
    if (process.env.MICHI_CLOUD === '1') {
      getDb().prepare('DELETE FROM chat_permission_grants WHERE node_id IN (SELECT n.id FROM nodes n JOIN workspaces w ON w.id = n.workspace_id WHERE w.owner_user_id = ?)').run(userId!);
    } else getDb().prepare('DELETE FROM chat_permission_grants').run();
  }
}

export function writeNodePermissionMode(nodeId: string, mode: ChatPermissionMode, userId?: string | null, initialOnly = false): void {
  if (!isChatPermissionMode(mode)) throw new Error('Invalid permission mode');
  const node = getNode(nodeId);
  if (!node || node.kind !== 'chat' || node.deleted_at) throw new Error('Chat not found');
  if (process.env.MICHI_CLOUD === '1' && (!userId || getWorkspace(node.workspace_id)?.owner_user_id !== userId)) {
    throw new Error('Chat not found');
  }
  getDb().prepare(`UPDATE nodes SET permission_mode = ? WHERE id = ?${initialOnly ? ' AND permission_mode IS NULL' : ''}`).run(mode, nodeId);
  if (mode === 'ask' && !initialOnly) getDb().prepare('DELETE FROM chat_permission_grants WHERE node_id = ?').run(nodeId);
}

export function hasChatToolGrant(nodeId: string, toolKey: string, userId?: string | null): boolean {
  const node = getNode(nodeId);
  if (!node || (process.env.MICHI_CLOUD === '1' && (!userId || getWorkspace(node.workspace_id)?.owner_user_id !== userId))) return false;
  return Boolean(getDb().prepare('SELECT 1 FROM chat_permission_grants WHERE node_id = ? AND tool_key = ?').get(nodeId, toolKey));
}

export function grantChatTool(nodeId: string, toolKey: string, userId?: string | null): void {
  const node = getNode(nodeId);
  if (!node || (process.env.MICHI_CLOUD === '1' && (!userId || getWorkspace(node.workspace_id)?.owner_user_id !== userId))) return;
  getDb().prepare('INSERT OR IGNORE INTO chat_permission_grants (node_id, tool_key) VALUES (?, ?)').run(nodeId, toolKey);
}

export function resolveChatPermissionMode(nodeId: string, userId?: string | null): ChatPermissionMode {
  const node = getNode(nodeId);
  if (process.env.MICHI_CLOUD === '1' && (!node || !userId || getWorkspace(node.workspace_id)?.owner_user_id !== userId)) return 'ask';
  const settings = readChatPermissionSettings(userId);
  if (settings.global) return settings.mode;
  return isChatPermissionMode(node?.permission_mode) ? node.permission_mode : 'ask';
}
