import type { MemoryChangedEvent } from 'michi-shared';
import { log } from '../logger';
import { memoryEvents } from './memoryService';

/**
 * Forwards memoryEvents 'changed' (C4) to the renderers of the owner who
 * made, or was the subject of, the change: Settings › Memory's list and
 * pending badge, and the "Remembered" toast. A listener only ever receives
 * its own owner's changes, whatever wrote them (Settings, an agent's memory
 * tools, background extraction).
 *
 * Delivery is deferred to the next turn of the event loop, so a socket write
 * never runs inside the store's transaction and a failing listener cannot
 * affect the change.
 */

type MemoryChangeListener = (event: MemoryChangedEvent) => void;

const listenersByOwner = new Map<string, Set<MemoryChangeListener>>();

function deliver(event: MemoryChangedEvent): void {
  const listeners = listenersByOwner.get(event.ownerUserId);
  if (!listeners || listeners.size === 0) return;
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (error) {
      log.warn('workspace', 'memory change subscriber failed', { action: event.action, error: (error as Error).message });
    }
  }
}

function forward(event: MemoryChangedEvent): void {
  if (!listenersByOwner.has(event.ownerUserId)) return;
  setImmediate(deliver, event);
}

/**
 * Call `listener` with every later change to `ownerUserId`'s memories and
 * nobody else's. Returns the unsubscribe function; memoryEvents carries no
 * listener of this module while nobody is subscribed.
 */
export function subscribeMemoryChanges(ownerUserId: string, listener: MemoryChangeListener): () => void {
  const owner = typeof ownerUserId === 'string' ? ownerUserId.trim() : '';
  if (!owner) throw new Error('ownerUserId is required');
  if (listenersByOwner.size === 0) memoryEvents.on('changed', forward);
  let listeners = listenersByOwner.get(owner);
  if (!listeners) {
    listeners = new Set();
    listenersByOwner.set(owner, listeners);
  }
  // A wrapper per subscription, so the same function subscribed twice is two subscriptions.
  const entry: MemoryChangeListener = (event) => listener(event);
  listeners.add(entry);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const current = listenersByOwner.get(owner);
    if (!current) return;
    current.delete(entry);
    if (current.size > 0) return;
    listenersByOwner.delete(owner);
    if (listenersByOwner.size === 0) memoryEvents.off('changed', forward);
  };
}
