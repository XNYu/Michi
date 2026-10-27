import { useSyncExternalStore } from 'react';
import { OPEN_SCHEDULED_JOB_EVENT } from '../scheduledNav';

/** The detail page's title, also its crumb in the top bar. */
export const META_AGENT_PAGE_TITLE = 'Meta agent · Maintain Pages';

/**
 * Whether the Scheduled area shows the Meta agent's detail page instead of the
 * job list. Module state, like scheduledNav, so the sidebar row and the main
 * column agree without a shared parent. Opening a job's details closes it,
 * except a request for the job the shell remembers as selected: that is the
 * shell restoring Scheduled, and the page stays if it was the last view.
 */
let open = false;
let restoredJobId: string | null = null;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

/** `selectedJobId`: the job row the shell still remembers as selected. */
export function openMetaAgentDetail(selectedJobId: string | null = null): void {
  restoredJobId = selectedJobId;
  set(true);
}
export function closeMetaAgentDetail(): void { set(false); }

if (typeof window !== 'undefined') {
  window.addEventListener(OPEN_SCHEDULED_JOB_EVENT, (event) => {
    const jobId = (event as CustomEvent<{ jobId?: string }>).detail?.jobId ?? null;
    if (open && jobId !== null && jobId === restoredJobId) return;
    closeMetaAgentDetail();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useMetaAgentDetailOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open, () => false);
}

/** Asks the shell to show Settings › <section>; `michi:nav-page` alone opens the global drawer. */
export const OPEN_SETTINGS_SECTION_EVENT = 'michi:open-settings-section';

export function requestMetaAgentSettings(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: { section: 'meta-agent' } }));
  window.dispatchEvent(new CustomEvent('michi:nav-page', { detail: { page: 'settings' } }));
}
