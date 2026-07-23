import { API_BASE_URL } from '../../config/env';

export interface ClaimResult {
  owner: boolean;
  heldBy?: string;
}

export async function claimPane(chatId: string, ownerToken: string, windowId: string): Promise<ClaimResult> {
  const res = await fetch(`${API_BASE_URL}/chats/${chatId}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerToken, windowId }),
  });
  if (!res.ok) return { owner: false };
  return res.json() as Promise<ClaimResult>;
}

export async function heartbeatPane(chatId: string, ownerToken: string): Promise<boolean> {
  const res = await fetch(`${API_BASE_URL}/chats/${chatId}/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerToken }),
  });
  return res.ok;
}

export async function releasePane(chatId: string, ownerToken: string): Promise<void> {
  await fetch(`${API_BASE_URL}/chats/${chatId}/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerToken }),
  }).catch(() => {});
}
