import React from 'react';
import type { AgentStatus, SessionMode } from '../../services/api';

export const REASONING_LABELS: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

export interface PaneMenuAnchor {
  x: number;
  y: number;
  anchorBottom?: number;
  align?: 'start' | 'end';
  trigger?: HTMLButtonElement;
  keyboard?: boolean;
}

interface PaneComposerToolbarLeftProps {
  canAttach: boolean;
  toolbarTier: 0 | 1 | 2;
  enableAgentChip?: boolean;
  currentMode?: SessionMode;
  currentModeId?: string;
  availableModesCount: number;
  agentStatus: AgentStatus | null;
  onPickFile: () => void;
  onInsertMentionTrigger: () => void;
  onOpenAgentMenu: (anchor: PaneMenuAnchor) => void;
}

export function PaneComposerToolbarLeft({
  canAttach,
  toolbarTier,
  enableAgentChip = true,
  currentMode,
  currentModeId,
  availableModesCount,
  agentStatus,
  onPickFile,
  onInsertMentionTrigger,
  onOpenAgentMenu,
}: PaneComposerToolbarLeftProps) {
  const showAgentChip =
    enableAgentChip &&
    toolbarTier < 2 &&
    agentStatus?.capabilities.modes !== false &&
    !!(
      currentMode ||
      currentModeId ||
      availableModesCount > 0 ||
      agentStatus?.capabilities.modes === true
    );

  return (
    <>
      <span
        className="t-toolbar-chip"
        title={canAttach ? 'Attach file' : 'Open a workspace to attach files'}
        aria-disabled={!canAttach || undefined}
        onClick={(e) => {
          e.stopPropagation();
          if (canAttach) onPickFile();
        }}
        style={{ flexShrink: 0, padding: 0, width: 'var(--composer-chip-height, 26px)', justifyContent: 'center', lineHeight: 1 }}
      >
        +
      </span>

      <span
        className="t-toolbar-chip"
        title="Mention context or node"
        onClick={onInsertMentionTrigger}
        style={{ flexShrink: 0, padding: 0, width: 'var(--composer-chip-height, 26px)', justifyContent: 'center', lineHeight: 1 }}
      >
        @
      </span>

      {showAgentChip && (
        <span
          className="t-toolbar-chip"
          data-icononly={toolbarTier >= 1 ? 'true' : undefined}
          title={`Switch agent — ${currentMode?.name ?? currentModeId ?? 'agent'}`}
          onClick={(e) => {
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onOpenAgentMenu({ x: r.left, y: r.top, anchorBottom: r.top - 6 });
          }}
        >
          <span style={{ flexShrink: 0 }}>⎇</span>
          <span className="t-chip-label">{currentMode?.name ?? currentModeId ?? 'agent'}</span>
        </span>
      )}
    </>
  );
}
