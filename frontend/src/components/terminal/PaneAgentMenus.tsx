import React from 'react';
import type { AgentModelInfo, AgentReasoning, AgentStatus, SessionMode } from '../../services/api';
import ContextMenu, { type MenuSection } from '../ContextMenu';
import { REASONING_LABELS } from './PaneComposerToolbarLeft';

interface MenuAnchor {
  x: number;
  y: number;
  anchorBottom?: number;
}

interface PaneAgentMenusProps {
  agentMenu: MenuAnchor | null;
  modelMenu: MenuAnchor | null;
  availableModes: readonly SessionMode[];
  currentModeId?: string;
  agentStatus: AgentStatus | null;
  providerModels: readonly AgentModelInfo[];
  modelsLoading: boolean;
  modelsError: string | null;
  onSwitchAgent: (modeId: string) => void;
  onSaveModel: (modelId: string) => void;
  onRetryModels: () => void;
  onSaveReasoning: (reasoning: AgentReasoning) => void;
  onCloseAgentMenu: () => void;
  onCloseModelMenu: () => void;
}

export function PaneAgentMenus({
  agentMenu,
  modelMenu,
  availableModes,
  currentModeId,
  agentStatus,
  providerModels,
  modelsLoading,
  modelsError,
  onSwitchAgent,
  onSaveModel,
  onRetryModels,
  onSaveReasoning,
  onCloseAgentMenu,
  onCloseModelMenu,
}: PaneAgentMenusProps) {
  return (
    <>
      {agentMenu && (
        <ContextMenu
          x={agentMenu.x}
          y={agentMenu.y}
          anchorBottom={agentMenu.anchorBottom}
          width={525}
          maxHeight={192}
          searchable
          sections={[
            {
              items:
                availableModes.length === 0
                  ? [{ id: 'loading', label: 'Loading…', disabled: true, run: () => {} }]
                  : availableModes.map((m) => ({
                      id: m.id,
                      label: currentModeId === m.id ? `✓ ${m.name}` : m.name,
                      sublabel: m.description ? `— ${m.description}` : undefined,
                      run: () => {
                        if (m.id !== currentModeId) onSwitchAgent(m.id);
                      },
                    })),
            },
          ]}
          onClose={onCloseAgentMenu}
        />
      )}

      {modelMenu &&
        !!(
          agentStatus?.capabilities.providerModels ||
          agentStatus?.capabilities.models === true ||
          agentStatus?.capabilities.reasoning
        ) && (
          <ModelReasoningMenu
            anchor={modelMenu}
            agentStatus={agentStatus}
            providerModels={providerModels}
            modelsLoading={modelsLoading}
            modelsError={modelsError}
            onSaveModel={onSaveModel}
            onRetryModels={onRetryModels}
            onSaveReasoning={onSaveReasoning}
            onClose={onCloseModelMenu}
          />
        )}
    </>
  );
}

function ModelReasoningMenu({
  anchor,
  agentStatus,
  providerModels,
  modelsLoading,
  modelsError,
  onSaveModel,
  onRetryModels,
  onSaveReasoning,
  onClose,
}: {
  anchor: MenuAnchor;
  agentStatus: AgentStatus;
  providerModels: readonly AgentModelInfo[];
  modelsLoading: boolean;
  modelsError: string | null;
  onSaveModel: (modelId: string) => void;
  onRetryModels: () => void;
  onSaveReasoning: (reasoning: AgentReasoning) => void;
  onClose: () => void;
}) {
  const showModels =
    !!agentStatus.capabilities.providerModels ||
    agentStatus.capabilities.models === true;
  const showReasoning = !!agentStatus.capabilities.reasoning;
  const isProvider = !!agentStatus.capabilities.providerModels;
  const sections: MenuSection[] = [];

  if (showModels) {
    sections.push({
      label: 'Models',
      trailingGlyph: true,
      items:
        providerModels.length === 0
          ? modelsError
            ? [
                { id: 'model-error', label: modelsError, disabled: true, run: () => {} },
                { id: 'model-retry', label: 'Retry', run: onRetryModels },
              ]
            : modelsLoading
              ? [{ id: 'loading', label: 'Loading models…', disabled: true, run: () => {} }]
              : [{ id: 'empty', label: 'No models available', disabled: true, run: () => {} }]
          : providerModels.map((m) => ({
              id: `m-${m.id}`,
              label: m.label || m.id,
              sublabel: isProvider ? m.id : undefined,
              glyph: agentStatus.model === m.id ? '✓' : undefined,
              run: () => onSaveModel(m.id),
            })),
    });
    if (providerModels.length > 0 && modelsError) {
      sections.push({
        label: 'Catalog refresh',
        items: [
          { id: 'model-refresh-error', label: modelsError, disabled: true, run: () => {} },
          { id: 'model-refresh-retry', label: 'Retry', run: onRetryModels },
        ],
      });
    }
  }

  if (showReasoning) {
    const levels: AgentReasoning[] = agentStatus.capabilities.supportedReasoningLevels?.length
      ? agentStatus.capabilities.supportedReasoningLevels
      : ['minimal', 'low', 'medium', 'high', 'xhigh'];
    sections.push({
      label: 'Effort',
      trailingGlyph: true,
      items: levels.map((id) => ({
        id: `r-${id}`,
        label: REASONING_LABELS[id] ?? id,
        glyph: agentStatus.reasoning === id ? '✓' : undefined,
        run: () => onSaveReasoning(id),
      })),
    });
  }

  return (
    <ContextMenu
      x={anchor.x}
      y={anchor.y}
      anchorBottom={anchor.anchorBottom}
      searchable={isProvider}
      maxHeight={220}
      width={isProvider ? 380 : undefined}
      sections={sections}
      onClose={onClose}
    />
  );
}
