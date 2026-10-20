import type {
  DeskNow,
  DeskPeek,
  DeskProjectView,
  DeskResume,
  DeskThread,
  DeskWrite,
} from 'michi-shared';
import { API_BASE_URL } from '../../config/env';

export type DeskMutation = 'archive' | 'ignore' | 'unarchive' | 'unignore' | 'done';

async function deskJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`desk_${response.status}`);
  return response.json() as Promise<T>;
}

export function getDeskNow(since?: number, signal?: AbortSignal): Promise<DeskNow> {
  const query = since == null ? '' : `?since=${encodeURIComponent(String(since))}`;
  return deskJson<DeskNow>(`/desk/now${query}`, { signal });
}

export function getDeskThreads(signal?: AbortSignal): Promise<{ threads: DeskThread[] }> {
  return deskJson('/desk/threads', { signal });
}

export function getDeskProject(id: string, signal?: AbortSignal): Promise<DeskProjectView> {
  return deskJson(`/desk/projects/${encodeURIComponent(id)}`, { signal });
}

export function getDeskPeek(id: string, signal?: AbortSignal): Promise<DeskPeek> {
  return deskJson(`/desk/threads/${encodeURIComponent(id)}/peek`, { signal });
}

export function getDeskResume(id: string): Promise<DeskResume> {
  return deskJson(`/desk/threads/${encodeURIComponent(id)}/resume`);
}

export function markDeskLooked(): Promise<{ ok: true }> {
  return deskJson('/desk/looked', { method: 'POST' });
}

export function markDeskProjectLooked(id: string): Promise<{ ok: true }> {
  return deskJson(`/desk/projects/${encodeURIComponent(id)}/looked`, { method: 'POST' });
}

export function postDeskMutation(action: DeskMutation, ids: string[]): Promise<DeskWrite> {
  return deskJson(`/desk/threads/${action}`, {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}

export function undoDeskReceipt(id: string): Promise<{ ok: true }> {
  return deskJson(`/desk/receipts/${encodeURIComponent(id)}/undo`, { method: 'POST' });
}
