import { parseSessionState, type AgentSessionState } from 'michi-shared';
import { executeChatCommand } from '../services/api/sessions';
import { compactChat } from '../services/api';
import type { PendingQueuedMessage } from './chatTypes';

export interface ChatCommand { name: string; value?: string }

/** A command must occupy the whole input. File paths and multiline prose
 * remain messages. Unknown Kiro commands get an explicit unsupported result. */
export function parseChatCommand(text: string, runtimeId?: string, engine?: string): ChatCommand | null {
  const match = text.trim().match(/^\/([\w-]+)(?:[ \t]+([^\r\n]*))?$/);
  if (!match || (runtimeId !== 'kiro' && match[1] !== 'compact')) return null;
  if (['branch', 'fork', 'fan'].includes(match[1])) return null;
  if (runtimeId === 'kiro' && engine === 'v2' && !['compact', 'tools', 'context', 'effort', 'clear'].includes(match[1])) return null;
  return { name: match[1], value: match[2]?.trim() || undefined };
}

/** Preserve command boundaries when draining a queue; ordinary adjacent
 * messages still combine exactly as before. */
export function nextQueuedBatch(queue: readonly PendingQueuedMessage[], runtimeId?: string, engine?: string): PendingQueuedMessage[] {
  const commandAt = (entry: PendingQueuedMessage) => parseChatCommand(entry.value, runtimeId, engine);
  if (!queue.length) return [];
  if (commandAt(queue[0])) return [queue[0]];
  const next = queue.findIndex(commandAt);
  return queue.slice(0, next < 0 ? queue.length : next);
}

export async function executeComposerCommand(nodeId: string, command: ChatCommand): Promise<{
  success: boolean; message: string; sessionState?: AgentSessionState;
}> {
  if (command.name === 'compact') {
    const result = await compactChat(nodeId, command.value);
    return { success: result.started, message: result.detail ?? (result.started ? 'Compaction completed.' : 'Compaction is unavailable.') };
  }
  const result = await executeChatCommand(nodeId, command.name, command.value ? { value: command.value } : undefined);
  const data = result.data === undefined ? '' : typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
  return { success: result.success, message: [result.message, data].filter(Boolean).join('\n') || (result.success ? `/${command.name} completed.` : `/${command.name} is unavailable.`),
    sessionState: result.sessionState ? parseSessionState({ ...result.sessionState }) : undefined,
  };
}
