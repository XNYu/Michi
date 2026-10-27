import { ownerMode } from '../../contract/host';
import type { RuntimeSessionOwner } from '../../contract/types';

// Kiro reads an owner's mode and key only: an interactive owner is a chat the
// user drives, a headless one runs without the user. The host chose the key,
// which is also the session's public id.

/** A session owner the user drives (no owner is neither). */
export function isInteractiveOwner(owner: RuntimeSessionOwner | null | undefined): owner is RuntimeSessionOwner {
    return owner != null && ownerMode(owner) === 'interactive';
}

/** A session owner that runs without the user (no owner is neither). */
export function isHeadlessOwner(owner: RuntimeSessionOwner | null | undefined): owner is RuntimeSessionOwner {
    return owner != null && ownerMode(owner) === 'headless';
}
