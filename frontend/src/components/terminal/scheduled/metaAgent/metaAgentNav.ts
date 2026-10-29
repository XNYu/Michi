import { openScheduledHome, setScheduledRoute, useScheduledRoute } from '../scheduledNav';

/** The detail page's title, also its crumb in the top bar. */
export const META_AGENT_PAGE_TITLE = 'Meta agent · Maintain Pages';

export function openMetaAgentDetail(): void { setScheduledRoute({ kind: 'meta-agent' }); }
export function closeMetaAgentDetail(): void { openScheduledHome(); }
export function useMetaAgentDetailOpen(): boolean { return useScheduledRoute().kind === 'meta-agent'; }

/** Asks the shell to show Settings › <section>; `michi:nav-page` alone opens the global drawer. */
export const OPEN_SETTINGS_SECTION_EVENT = 'michi:open-settings-section';

export function requestMetaAgentSettings(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: { section: 'meta-agent' } }));
  window.dispatchEvent(new CustomEvent('michi:nav-page', { detail: { page: 'settings' } }));
}
