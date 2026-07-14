import { useMemo } from 'react';
import { useChatStore } from '../state/chatStore';
import { usePrefs } from '../state/prefs';

/**
 * Computes the shared container style for all pane types (TPane, DigestPane,
 * ArtifactPane, and any future pane). Encapsulates:
 *
 *  - flex column layout
 *  - theme-driven border/radius/shadow
 *  - paneRules-gated right divider
 *  - focus dim (opacity + brightness filter)
 *  - transitions
 *
 * Consumers spread the result and optionally override specific properties:
 *
 *   const shellStyle = usePaneShellStyle(nodeId);
 *   <div style={{ ...shellStyle, borderLeft: '3px solid ...' }}>
 */
export function usePaneShellStyle(nodeId: string): React.CSSProperties {
  const { focusedPane } = useChatStore();
  const { prefs } = usePrefs();
  const isFocused = focusedPane === nodeId || focusedPane == null;

  return useMemo<React.CSSProperties>(
    () => ({
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--term-pane-bg, var(--term-surface))',
      border: 'var(--term-pane-border, none)',
      borderRight: prefs.paneRules
        ? 'var(--term-pane-divider, 1px solid var(--term-line))'
        : 'none',
      borderRadius: 'var(--term-pane-radius, 0px)',
      boxShadow: 'var(--term-pane-shadow, none)',
      minWidth: 0,
      minHeight: 0,
      height: '100%',
      overflow: 'hidden',
      fontFamily: 'var(--ui-font)',
      animation: 'none',
      opacity: isFocused ? 1 : 1 - prefs.focusDim / 100 * 0.5,
      filter: isFocused ? 'none' : `brightness(${1 - prefs.focusDim / 100 * 0.6})`,
      transition: 'opacity var(--t-soft) var(--t-ease), filter var(--t-soft) var(--t-ease)',
      position: 'relative',
    }),
    [isFocused, prefs.paneRules, prefs.focusDim],
  );
}
