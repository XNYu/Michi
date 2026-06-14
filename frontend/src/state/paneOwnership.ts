import type { ClaimResult } from '../services/api';

export type OwnerRole = 'owner' | 'observer';

export interface OwnerState {
  role: OwnerRole;
  heldBy?: string;
}

export type OwnerStateMap = Record<string, OwnerState>;

export type OwnerEvent =
  | { type: 'claim-result'; nodeId: string; result: ClaimResult }
  | { type: 'heartbeat-demoted'; nodeId: string }
  | { type: 'released'; nodeId: string };

export function ownerStateReducer(state: OwnerStateMap, ev: OwnerEvent): OwnerStateMap {
  switch (ev.type) {
    case 'claim-result': {
      const next: OwnerState = ev.result.owner
        ? { role: 'owner' }
        : { role: 'observer', ...(ev.result.heldBy ? { heldBy: ev.result.heldBy } : {}) };
      const cur = state[ev.nodeId];
      if (cur?.role === next.role && cur.heldBy === next.heldBy) return state;
      return { ...state, [ev.nodeId]: next };
    }
    case 'heartbeat-demoted': {
      const cur = state[ev.nodeId];
      if (!cur || cur.role === 'observer') return state;
      return { ...state, [ev.nodeId]: { role: 'observer' } };
    }
    case 'released': {
      if (!(ev.nodeId in state)) return state;
      const { [ev.nodeId]: _drop, ...rest } = state;
      return rest;
    }
  }
}

export function mintOwnerToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tok-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
