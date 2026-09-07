import React, { useRef } from 'react';
import type { AgentCapabilities, AgentModelInfo, AgentReasoning, AgentStatus, SessionMode } from '../../services/api';
import type { ResolvedNodeBinding } from '../../state/nodeBindingResolution';
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
  resolvedBinding: ResolvedNodeBinding;
  catalogCapabilities: AgentCapabilities | null;
  providerModels: readonly AgentModelInfo[];
  modelsLoading: boolean;
  modelsWaiting?: boolean;
  modelsError: string | null;
  onSwitchAgent: (modeId: string) => void;
  onSwitchRuntime: (runtimeId: string) => void;
  onSaveModel: (modelId: string) => void;
  onRetryModels: () => void;
  onSaveReasoning: (reasoning: AgentReasoning) => void;
  onCloseAgentMenu: () => void;
  onCloseModelMenu: () => void;
  primaryAgents?: readonly PrimaryAgentMenuOption[];
  selectedPrimaryAgentId?: string;
  primaryAgentsLoading?: boolean;
  primaryAgentsError?: string | null;
  onSelectPrimaryAgent?: (id: string) => void;
  onSelectDefaultAgent?: () => void;
}

export interface PrimaryAgentMenuOption {
  id: string;
  name: string;
  scope: 'global' | 'workspace';
  runtimeSummary: string;
}

export function PaneAgentMenus({
  agentMenu,
  modelMenu,
  availableModes,
  currentModeId,
  agentStatus,
  resolvedBinding,
  catalogCapabilities,
  providerModels,
  modelsLoading,
  modelsWaiting = false,
  modelsError,
  onSwitchAgent,
  onSwitchRuntime,
  onSaveModel,
  onRetryModels,
  onSaveReasoning,
  onCloseAgentMenu,
  onCloseModelMenu,
  primaryAgents = [],
  selectedPrimaryAgentId,
  primaryAgentsLoading = false,
  primaryAgentsError = null,
  onSelectPrimaryAgent,
  onSelectDefaultAgent,
}: PaneAgentMenusProps) {
  const primarySections: MenuSection[] = onSelectPrimaryAgent && onSelectDefaultAgent
    ? [
        {
          label: 'Conversation Agent',
          items: [{
            id: 'primary-default',
            label: selectedPrimaryAgentId ? 'Default Michi Agent' : '✓ Default Michi Agent',
            sublabel: 'Uses the runtime and model controls below',
            run: onSelectDefaultAgent,
          }],
        },
        ...(['workspace', 'global'] as const).map((scope) => ({
          label: scope === 'workspace' ? 'Workspace Agents' : 'Global Agents',
          items: primaryAgents.filter((agent) => agent.scope === scope).map((agent) => ({
            id: `primary-${agent.id}`,
            label: selectedPrimaryAgentId === agent.id ? `✓ ${agent.name}` : agent.name,
            sublabel: agent.runtimeSummary,
            run: () => onSelectPrimaryAgent(agent.id),
          })),
        })).filter((section) => section.items.length > 0),
        ...(primaryAgentsLoading ? [{ items: [{ id: 'primary-loading', label: 'Loading Custom Agents…', disabled: true, run: () => {} }] }] : []),
        ...(primaryAgentsError ? [{ items: [{ id: 'primary-error', label: primaryAgentsError, disabled: true, run: () => {} }] }] : []),
      ]
    : [];
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
            ...primarySections,
            {
              label: primarySections.length > 0 ? 'Built-in Modes' : undefined,
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

      {modelMenu && (
        <ModelReasoningMenu
          key={JSON.stringify([resolvedBinding.runtime, resolvedBinding.provider])}
          anchor={modelMenu}
          agentStatus={agentStatus}
          resolvedBinding={resolvedBinding}
          catalogCapabilities={catalogCapabilities}
          providerModels={providerModels}
          modelsLoading={modelsLoading}
          modelsWaiting={modelsWaiting}
          modelsError={modelsError}
          onSwitchRuntime={onSwitchRuntime}
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
  resolvedBinding,
  catalogCapabilities,
  providerModels,
  modelsLoading,
  modelsWaiting,
  modelsError,
  onSwitchRuntime,
  onSaveModel,
  onRetryModels,
  onSaveReasoning,
  onClose,
}: {
  anchor: MenuAnchor;
  agentStatus: AgentStatus | null;
  resolvedBinding: ResolvedNodeBinding;
  catalogCapabilities: AgentCapabilities | null;
  providerModels: readonly AgentModelInfo[];
  modelsLoading: boolean;
  modelsWaiting: boolean;
  modelsError: string | null;
  onSwitchRuntime: (runtimeId: string) => void;
  onSaveModel: (modelId: string) => void;
  onRetryModels: () => void;
  onSaveReasoning: (reasoning: AgentReasoning) => void;
  onClose: () => void;
}) {
  const reloading = useRef(false);
  const reload = () => {
    reloading.current = true;
    onRetryModels();
  };
  const close = () => {
    if (reloading.current) {
      reloading.current = false;
      return;
    }
    onClose();
  };

  const caps = catalogCapabilities ?? agentStatus?.capabilities;
  const showModels = !!(caps?.providerModels || caps?.models === true);
  const showReasoning = !!caps?.reasoning;
  const isProvider = !!caps?.providerModels;
  const sections: MenuSection[] = [];

  // Runtime section — always show so users can switch runtime per-node.
  if (agentStatus?.availableRuntimes && agentStatus.availableRuntimes.length > 1) {
    sections.push({
      label: 'Runtime',
      trailingGlyph: true,
      items: agentStatus.availableRuntimes.map((r) => ({
        id: `rt-${r.id}`,
        label: r.label || r.id,
        glyph: resolvedBinding.runtime === r.id ? '✓' : undefined,
        run: () => {
          if (r.id !== resolvedBinding.runtime) onSwitchRuntime(r.id);
        },
      })),
    });
  }

  if (showModels) {
    if (resolvedBinding.model && (modelsLoading || modelsError || !providerModels.some((m) => m.id === resolvedBinding.model))) {
      sections.push({
        items: [{
          id: 'model-current',
          label: 'Use current model',
          sublabel: resolvedBinding.model,
          glyph: '✓',
          run: () => {},
        }],
      });
    }
    if (modelsLoading || modelsError || providerModels.length === 0) {
      sections.push({
        label: 'Model catalog',
        items: [
          {
            id: 'model-status',
            label: modelsError || (modelsLoading
              ? modelsWaiting ? 'Still loading models…' : 'Loading models…'
              : 'No models available'),
            disabled: true,
            run: () => {},
          },
          ...(modelsError || modelsWaiting || !modelsLoading
            ? [{ id: 'model-retry', label: modelsError ? 'Retry' : 'Reload models', run: reload }]
            : []),
        ],
      });
    }
    if (providerModels.length > 0) {
      sections.push({
        label: 'Models',
        trailingGlyph: true,
        items: providerModels.map((m) => ({
          id: `m-${m.id}`,
          label: m.label || m.id,
          sublabel: isProvider ? m.id : undefined,
          glyph: resolvedBinding.model === m.id ? '✓' : undefined,
          run: () => onSaveModel(m.id),
        })),
      });
    }
  }

  if (showReasoning) {
    const levels: AgentReasoning[] = caps?.supportedReasoningLevels?.length
      ? caps.supportedReasoningLevels
      : ['minimal', 'low', 'medium', 'high', 'xhigh'];
    sections.push({
      label: 'Effort',
      trailingGlyph: true,
      items: levels.map((id) => ({
        id: `r-${id}`,
        label: REASONING_LABELS[id] ?? id,
        glyph: resolvedBinding.reasoning === id ? '✓' : undefined,
        run: () => onSaveReasoning(id),
      })),
    });
  }

  return (
    <ContextMenu
      x={anchor.x}
      y={anchor.y}
      anchorBottom={anchor.anchorBottom}
      searchable={isProvider || (agentStatus?.availableRuntimes?.length ?? 0) > 3}
      maxHeight={280}
      width={isProvider ? 380 : undefined}
      sections={sections}
      onClose={close}
    />
  );
}
