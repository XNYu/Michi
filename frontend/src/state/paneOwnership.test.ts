import { describe, expect, it } from 'vitest';
import { ownerStateReducer, type OwnerStateMap } from './paneOwnership';

describe('ownerStateReducer', () => {
  it('claim success marks a node owner', () => {
    const state = ownerStateReducer({}, {
      type: 'claim-result',
      nodeId: 'n1',
      result: { owner: true },
    });

    expect(state.n1).toEqual({ role: 'owner' });
  });

  it('claim failure marks a node observer with heldBy', () => {
    const state = ownerStateReducer({}, {
      type: 'claim-result',
      nodeId: 'n1',
      result: { owner: false, heldBy: 'win-9' },
    });

    expect(state.n1).toEqual({ role: 'observer', heldBy: 'win-9' });
  });

  it('heartbeat demotion flips owner to observer', () => {
    const state: OwnerStateMap = { n1: { role: 'owner' } };

    const next = ownerStateReducer(state, { type: 'heartbeat-demoted', nodeId: 'n1' });

    expect(next.n1).toEqual({ role: 'observer' });
  });

  it('release removes the node entry', () => {
    const state: OwnerStateMap = { n1: { role: 'owner' } };

    const next = ownerStateReducer(state, { type: 'released', nodeId: 'n1' });

    expect(next.n1).toBeUndefined();
  });

  it('returns the same reference when the state is unchanged', () => {
    const state: OwnerStateMap = { n1: { role: 'owner' } };

    const next = ownerStateReducer(state, {
      type: 'claim-result',
      nodeId: 'n1',
      result: { owner: true },
    });

    expect(next).toBe(state);
  });
});
