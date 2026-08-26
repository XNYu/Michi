import React from 'react';
import type { AgentModelInfo, AgentStatus, SessionMode } from '../../services/api';

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
  anchorBottom: number;
}

interface PaneComposerToolbarLeftProps {
  canAttach: boolean;
  toolbarTier: 0 | 1 | 2;
  enableAgentChip?: boolean;
  currentMode?: SessionMode;
  currentModeId?: string;
  availableModesCount: number;
  agentStatus: AgentStatus | null;
  providerModels: readonly AgentModelInfo[];
  onPickFile: () => void;
  onInsertMentionTrigger: () => void;
  onOpenAgentMenu: (anchor: PaneMenuAnchor) => void;
  onOpenModelMenu: (anchor: PaneMenuAnchor, shouldLoadModels: boolean) => void;
}

export function PaneComposerToolbarLeft({
  canAttach,
  toolbarTier,
  enableAgentChip = true,
  currentMode,
  currentModeId,
  availableModesCount,
  agentStatus,
  providerModels,
  onPickFile,
  onInsertMentionTrigger,
  onOpenAgentMenu,
  onOpenModelMenu,
}: PaneComposerToolbarLeftProps) {
  const providerLabel =
    (agentStatus?.providers ?? []).find((p) => p.id === agentStatus?.provider)?.label ??
    agentStatus?.provider ??
    'ai';
  const showModelChip =
    toolbarTier < 2 &&
    !!(
      agentStatus?.capabilities.providerModels ||
      agentStatus?.capabilities.models === true ||
      agentStatus?.capabilities.reasoning
    );
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
          style={{ color: 'var(--term-mauve)' }}
        >
          <span style={{ flexShrink: 0 }}>⎇</span>
          <span className="t-chip-label">{currentMode?.name ?? currentModeId ?? 'agent'}</span>
        </span>
      )}

      {toolbarTier < 2 && agentStatus?.capabilities.providerModels && (
        <span
          className="t-toolbar-chip"
          data-icononly={toolbarTier >= 1 ? 'true' : undefined}
          title={`Provider — ${providerLabel}`}
          style={{ color: 'var(--term-mauve)' }}
        >
          <span style={{ flexShrink: 0 }}>API</span>
          <span className="t-chip-label">{providerLabel}</span>
        </span>
      )}

      {showModelChip && (() => {
        const showModels =
          !!agentStatus?.capabilities.providerModels ||
          agentStatus?.capabilities.models === true;
        const showReasoning = !!agentStatus?.capabilities.reasoning;
        const modelLabel =
          providerModels.find((m) => m.id === agentStatus?.model)?.label ||
          agentStatus?.model ||
          'model';
        const reasoningLabel =
          REASONING_LABELS[agentStatus?.reasoning ?? ''] ??
          agentStatus?.reasoning ??
          '';
        const parts: string[] = [];
        if (showModels) parts.push(modelLabel);
        if (showReasoning && reasoningLabel) parts.push(reasoningLabel);

        return (
          <span
            className="t-toolbar-chip"
            title={
              showModels && showReasoning
                ? 'Change model & reasoning effort'
                : showModels
                  ? `Change model — ${modelLabel}`
                  : 'Change reasoning effort'
            }
            onClick={(e) => {
              e.stopPropagation();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              onOpenModelMenu({ x: r.left, y: r.top, anchorBottom: r.top - 6 }, showModels);
            }}
          >
            <span className="t-chip-label">{parts.join(' · ') || '…'}</span>
          </span>
        );
      })()}
    </>
  );
}
