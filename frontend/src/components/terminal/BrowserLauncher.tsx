import React from 'react';
import { toast } from 'sonner';
import { useChatActions, useChatPanes } from '../../state/chatStore';
import { usePrefs } from '../../state/prefs';

/** Open the browser directly, using the current pane's rendered width. */
export default function BrowserLauncher() {
  const { openPanes, focusedPane, paneItems } = useChatPanes();
  const { openBrowserPane, focusPane, setPaneWidth } = useChatActions();
  const { prefs } = usePrefs();
  return <button type="button" className="t-icon-btn" aria-label="Browser" title="Browser"
    onClick={event => {
      try {
        const existing = openPanes.find(id => paneItems[id]?.kind === 'browser');
        if (existing) {
          focusPane(existing);
          window.dispatchEvent(new CustomEvent('michi:nav-page', { detail: { page: 'dashboard' } }));
          return;
        }
        const shell = event.currentTarget.closest('.terminal-shell');
        const strip = shell?.querySelector<HTMLElement>('.terminal-dashboard');
        const panes = Array.from(strip?.querySelectorAll<HTMLElement>(':scope > [data-node-id]') ?? []);
        const current = panes.find(pane => pane.dataset.nodeId === focusedPane) ?? panes[0];
        const available = strip?.getBoundingClientRect().width ?? 0;
        const style = strip ? getComputedStyle(strip) : null;
        const padding = parseFloat(style?.getPropertyValue('--term-dashboard-padding') ?? '') || 0;
        const gap = parseFloat(style?.getPropertyValue('--term-dashboard-gap') ?? '') || 0;
        // A lone full-width pane becomes an equal split. Otherwise retain the
        // current pane's actual width, including any manual resize.
        const width = Math.max(1, Math.min(current?.getBoundingClientRect().width || prefs.defaultPaneWidth,
          available > 0 ? (available - padding * 4 - gap) / 2 : prefs.defaultPaneWidth));
        if (panes.length > 1 && current?.dataset.nodeId) setPaneWidth(current.dataset.nodeId, width);
        const id = openBrowserPane();
        setPaneWidth(id, width);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Unable to open browser');
      }
    }}
    style={{ width: 26, height: 26, color: 'var(--term-mid)', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></svg>
  </button>;
}
