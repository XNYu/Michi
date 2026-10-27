// Runtime session owners as Michi builds them (agents/ownerMapping): tests
// build and compare owners through these instead of writing the shape out.
import { hostOwner } from '../../src/agents/ownerMapping';
import type { RuntimeSessionOwner } from '../../src/agents/types';

export { chatOwner, runOwner, hostOwner, isRunOwner, sameHostOwner } from '../../src/agents/ownerMapping';

/**
 * JSON.stringify replacer for recorded fixtures: an owner (under an `owner`
 * or `submitter` key) is written the way Michi names it, so fixtures that
 * predate the runtime owner's mode and key still match unchanged.
 */
export function recordOwnerAsHost(key: string, value: unknown): unknown {
  if ((key === 'owner' || key === 'submitter') && value !== null && typeof value === 'object') {
    return hostOwner(value as RuntimeSessionOwner);
  }
  return value;
}
