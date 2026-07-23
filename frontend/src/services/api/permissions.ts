import { API_BASE_URL } from '../../config/env';

// ── Permission Response API ──

export async function respondToPermission(
  chatId: string,
  requestId: number,
  optionId: string,
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/chats/${chatId}/permission-response`, {
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
  const res = await fetch(`${API_BASE_URL}/chats/${chatId}/permission-response`, {
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
  answers: Array<{ question: string; answer: string }>,
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/chats/${chatId}/user-input-response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, answers }),
  });
  if (!res.ok) throw new Error(`User input response failed: ${res.status}`);
}

export async function skipUserInput(
  chatId: string,
  requestId: number,
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/chats/${chatId}/user-input-response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, skip: true }),
  });
  if (!res.ok) throw new Error(`User input skip failed: ${res.status}`);
}
