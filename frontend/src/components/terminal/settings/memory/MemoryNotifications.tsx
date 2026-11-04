import { useMemoryNotifications } from '../../../../state/memory/memoryNotifications';
import { OPEN_SETTINGS_SECTION_EVENT } from '../../scheduled/metaAgent/metaAgentNav';

/** Opens Settings › Memory, where memories waiting for approval are. */
function openMemorySettings(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: { section: 'memory' } }));
}

/**
 * Memory change toasts and the pending count, once the workspaces have
 * loaded (the shell mounts it after hydration, like the other feeds).
 * Renders nothing; a toast's Review opens Settings › Memory on request only.
 */
export function MemoryNotifications() {
  useMemoryNotifications(openMemorySettings);
  return null;
}
