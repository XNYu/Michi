import { ownerMode } from '../../contract/host';
import type { RuntimeSessionOwner } from '../../contract/types';

// Claude reads an owner's mode and key only. The key, chosen by the host, is
// the session's public id and the host's key for an interactive owner's
// binding, fork anchors and self turns.

/** ownerMode(owner) === 'interactive'. */
export function isInteractiveOwner(owner: RuntimeSessionOwner): boolean {
  return ownerMode(owner) === 'interactive';
}

/** ownerMode(owner) === 'headless'. */
export function isHeadlessOwner(owner: RuntimeSessionOwner): boolean {
  return ownerMode(owner) === 'headless';
}
