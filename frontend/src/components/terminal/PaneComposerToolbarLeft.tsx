import React from 'react';
import type { AgentCapabilities, AgentModelInfo, AgentStatus, SessionMode } from '../../services/api';
import type { ResolvedNodeBinding } from '../../state/nodeBindingResolution';

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
  resolvedBinding: ResolvedNodeBinding;
  catalogCapabilities: AgentCapabilities | null;
  providerModels: readonly AgentModelInfo[];
  isStreaming: boolean;
  onPickFile: () => void;
  onInsertMentionTrigger: () => void;
  onOpenAgentMenu: (anchor: PaneMenuAnchor) => void;
  onOpenModelMenu: (anchor: PaneMenuAnchor, shouldLoadModels: boolean) => void;
  onOpenRuntimeMenu: (anchor: PaneMenuAnchor) => void;
}

export function PaneComposerToolbarLeft({
  canAttach,
  toolbarTier,
  enableAgentChip = true,
  currentMode,
  currentModeId,
  availableModesCount,
  agentStatus,
  resolvedBinding,
  catalogCapabilities,
  providerModels,
  isStreaming,
  onPickFile,
  onInsertMentionTrigger,
  onOpenAgentMenu,
  onOpenModelMenu,
  onOpenRuntimeMenu,
}: PaneComposerToolbarLeftProps) {
  // Effective capabilities: use catalog capabilities if available (from the
  // resolved runtime's catalog), otherwise fall back to agentStatus (which
  // reflects the global active runtime).
  const caps = catalogCapabilities ?? agentStatus?.capabilities;

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

  // Runtime chip: always shown (users can switch runtime per-node).
  const runtimeLabel = agentStatus?.availableRuntimes?.find(
    (r) => r.id === resolvedBinding.runtime,
  )?.label ?? resolvedBinding.runtime ?? 'runtime';
  const showRuntimeChip = toolbarTier < 2;

  // Model chip: shown when the resolved runtime supports models.
  const showModelChip = toolbarTier < 2 && !!(
    caps?.providerModels ||
    caps?.models === true
  );
  const modelLabel =
    providerModels.find((m) => m.id === resolvedBinding.model)?.label ??
    resolvedBinding.model ??
    'model';

  // Effort chip: shown when the resolved runtime supports reasoning.
  const showEffortChip = toolbarTier < 2 && !!caps?.reasoning;
  const effortLabel =
    REASONING_LABELS[resolvedBinding.reasoning ?? ''] ??
    resolvedBinding.reasoning ??
    '';

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

      {showRuntimeChip && (
        <span
          className="t-toolbar-chip"
          data-icononly={toolbarTier >= 1 ? 'true' : undefined}
          title={`Runtime — ${runtimeLabel}`}
          aria-disabled={isStreaming || undefined}
          onClick={(e) => {
            if (isStreaming) return;
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onOpenRuntimeMenu({ x: r.left, y: r.top, anchorBottom: r.top - 6 });
          }}
          style={{
            color: 'var(--term-mauve)',
            opacity: resolvedBinding.source === 'global' ? 0.7 : 1,
          }}
        >
          <span className="t-chip-label">{runtimeLabel}</span>
        </span>
      )}

      {showModelChip && (
        <span
          className="t-toolbar-chip"
          title={`Model — ${modelLabel}`}
          aria-disabled={isStreaming || undefined}
          onClick={(e) => {
            if (isStreaming) return;
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onOpenModelMenu({ x: r.left, y: r.top, anchorBottom: r.top - 6 }, true);
          }}
        >
          <span className="t-chip-label">{modelLabel}</span>
        </span>
      )}

      {showEffortChip && effortLabel && (
        <span
          className="t-toolbar-chip"
          title={`Effort — ${effortLabel}`}
          aria-disabled={isStreaming || undefined}
          onClick={(e) => {
            if (isStreaming) return;
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onOpenModelMenu({ x: r.left, y: r.top, anchorBottom: r.top - 6 }, false);
          }}
        >
          <span className="t-chip-label">{effortLabel}</span>
        </span>
      )}
    </>
  );
}
