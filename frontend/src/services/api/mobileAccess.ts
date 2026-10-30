import type { MobileAccessLink, MobileAccessProvider, MobileAccessStatus } from 'michi-shared';
import { backendApiBase } from '../../config/backendConnections';
import { backendFetch } from './backendRequest';

export type MobileAccessAction = 'start' | 'stop' | 'link' | 'login' | 'open-app' | 'provider';
export async function mobileAccessRequest<T = MobileAccessStatus>(connectionId: string, action?: MobileAccessAction, signal?: AbortSignal, provider?: MobileAccessProvider): Promise<T> {
  const response = await backendFetch(`${backendApiBase(connectionId)}/mobile-access${action ? `/${action}` : ''}`, {
    method: action ? 'POST' : 'GET', credentials: 'include', signal,
    ...(provider ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider }) } : {}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Mobile access is unavailable on this machine. Update its Michi backend.');
  return body as T;
}
export const createMobileAccessLink = (connectionId: string) => mobileAccessRequest<MobileAccessLink>(connectionId, 'link');
