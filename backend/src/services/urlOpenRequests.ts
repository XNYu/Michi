import { randomUUID } from 'node:crypto';

export interface UrlOpenScope { workspaceId: string; treeId: string | null; ownerUserId: string | null }
export interface UrlOpenRequest { id: string; url: string; expiresAt: number }
const key = (scope: UrlOpenScope) => JSON.stringify([scope.ownerUserId, scope.workspaceId, scope.treeId]);

/** Ephemeral UI commands: one consumer, bounded lifetime, never durable turn replay. */
export class UrlOpenRequests {
  private requests = new Map<string, UrlOpenRequest[]>();
  private prune(now: number) {
    for (const [scope, values] of this.requests) {
      const alive = values.filter(value => value.expiresAt > now);
      if (alive.length) this.requests.set(scope, alive); else this.requests.delete(scope);
    }
  }
  enqueue(scope: UrlOpenScope, value: unknown, now = Date.now()): UrlOpenRequest {
    if (typeof value !== 'string' || value.length > 8192) throw new Error('A valid HTTP(S) URL is required');
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) URLs without embedded credentials are supported');
    this.prune(now);
    const values = this.requests.get(key(scope)) ?? [];
    if (values.length >= 8 || (!values.length && this.requests.size >= 256)) throw new Error('Too many pending open_url requests');
    const request = { id: randomUUID(), url: url.href, expiresAt: now + 30_000 };
    this.requests.set(key(scope), [...values, request]);
    return request;
  }
  claim(scope: UrlOpenScope, now = Date.now()): UrlOpenRequest | null {
    this.prune(now);
    const values = this.requests.get(key(scope));
    const request = values?.shift() ?? null;
    if (!values?.length) this.requests.delete(key(scope));
    return request;
  }
}
export const urlOpenRequests = new UrlOpenRequests();
