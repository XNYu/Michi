/**
 * Which workspaces and nodes belong to the Michi assistant. Every chat in an
 * assistant workspace (`settings.system = 'assistant'`) runs as the
 * assistant, current or archived, so none of them can become a worker.
 */

import { isAssistantWorkspaceSettings } from 'michi-shared';
import { getDb } from '../services/db';
import { getNode, getWorkspace } from '../services/dbRepository';
import type { AssistantPurpose } from './policy';

/** The `meta` key recording a non-Spaces assistant conversation's purpose (store.ts writes it). */
export const assistantPurposeKey = (nodeId: string) => `assistant:purpose:${nodeId}`;

/**
 * What an assistant conversation is for. Recorded for Scheduled
 * conversations only, when they are created; every other conversation,
 * including all from before purposes existed, is a Spaces one.
 */
export function assistantPurposeOf(nodeId: string | null | undefined): AssistantPurpose {
  if (!nodeId) return 'spaces';
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(assistantPurposeKey(nodeId)) as { value: string } | undefined;
  return row?.value === 'schedule' ? 'schedule' : 'spaces';
}

/**
 * True for the assistant's hidden workspace (any of them). Always false in
 * cloud mode: the assistant reads every workspace and maintains Pages on
 * this machine, so it exists only in the local app.
 */
export function isAssistantWorkspace(workspaceId: string | null | undefined): boolean {
  if (!workspaceId || process.env.MICHI_CLOUD === '1') return false;
  return isAssistantWorkspaceSettings(getWorkspace(workspaceId)?.settings);
}

/** True for every chat node in an assistant workspace. */
export function isAssistantNode(nodeId: string | null | undefined): boolean {
  if (!nodeId) return false;
  const node = getNode(nodeId);
  return !!node && isAssistantWorkspace(node.workspace_id);
}
