import { backendFetch } from './backendRequest';
import { nodeBackendApiBase } from '../../config/backendConnections';
import type { PermissionOption } from 'michi-shared';

export interface PermissionRequest {
  requestId: number;
  toolCallId?: string;
  title: string;
  detail?: string;
  options: PermissionOption[];
  source?: string;
}

// ── Permission Response API ──

export async function respondToPermission(
  chatId: string,
  requestId: number,
  optionId: string,
): Promise<void> {
  const res = await backendFetch(`${nodeBackendApiBase(chatId)}/chats/${chatId}/permission-response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, optionId }),
  });
  if (!res.ok) throw new Error(`Permission response failed: ${res.status}`);
}

export async function cancelPermission(
  chatId: string,
  requestId: number,
): Promise<void> {
  const res = await backendFetch(`${nodeBackendApiBase(chatId)}/chats/${chatId}/permission-response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, cancel: true }),
  });
  if (!res.ok) throw new Error(`Permission response failed: ${res.status}`);
}

// ── User Input Response API ──

export async function respondToUserInput(
  chatId: string,
  requestId: number,
  answers: Array<{ id?: string; question: string; answer: string }>,
  interactionId?: string,
): Promise<void> {
  const res = await backendFetch(`${nodeBackendApiBase(chatId)}/chats/${chatId}/user-input-response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, interactionId, answers }),
  });
  if (!res.ok) throw new Error(`User input response failed: ${res.status}`);
}

export async function skipUserInput(
  chatId: string,
  requestId: number,
  interactionId?: string,
): Promise<void> {
  const res = await backendFetch(`${nodeBackendApiBase(chatId)}/chats/${chatId}/user-input-response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, interactionId, skip: true }),
  });
  if (!res.ok) throw new Error(`User input skip failed: ${res.status}`);
}
