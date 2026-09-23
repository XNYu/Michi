import React, { useEffect } from 'react';
import type { AgentCapabilities, AgentModelInfo, AgentProviderInfo, AgentReasoning, AgentStatus, SessionMode } from '../../services/api';
import type { ResolvedNodeBinding } from '../../state/nodeBindingResolution';
import ContextMenu, { type MenuSection } from '../ContextMenu';
import type { PaneMenuAnchor } from './PaneComposerToolbarLeft';
import { ComposerModelPicker } from './ComposerModelPicker';

interface PaneAgentMenusProps {
  agentMenu: PaneMenuAnchor | null;
  modelMenu: PaneMenuAnchor | null;
  disabled?: boolean;
  availableModes: readonly SessionMode[];
  currentModeId?: string;
  agentStatus: AgentStatus | null;
  resolvedBinding: ResolvedNodeBinding;
  catalogCapabilities: AgentCapabilities | null;
  providerModels: readonly AgentModelInfo[];
  providers?: readonly AgentProviderInfo[];
  modelsLoading: boolean;
  modelsWaiting?: boolean;
  modelsError: string | null;
  onSwitchAgent: (modeId: string) => void;
  onSwitchRuntime: (runtimeId: string) => void | Promise<void>;
  onSaveProvider?: (providerId: string) => void | Promise<void>;
  onSaveModel: (modelId: string) => void | Promise<void>;
  onRetryModels: () => void;
  onSaveReasoning: (reasoning: AgentReasoning) => void | Promise<void>;
  onCloseAgentMenu: () => void;
  onCloseModelMenu: () => void;
  primaryAgents?: readonly PrimaryAgentMenuOption[];
  selectedPrimaryAgentId?: string;
  primaryAgentsLoading?: boolean;
  primaryAgentsError?: string | null;
  onSelectPrimaryAgent?: (id: string) => void;
  onSelectDefaultAgent?: () => void;
  /** The mode ACP assigns to a fresh session. Null when unavailable. */
  defaultModeId?: string | null;
  /** Current runtime id — used to derive the mode section header label. */
  runtimeId?: string;
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
  disabled = false,
  availableModes,
  currentModeId,
  agentStatus,
  resolvedBinding,
  catalogCapabilities,
  providerModels,
  providers = [],
  modelsLoading,
  modelsWaiting = false,
  modelsError,
  onSwitchAgent,
  onSwitchRuntime,
  onSaveProvider,
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
  defaultModeId,
  runtimeId,
}: PaneAgentMenusProps) {
  useEffect(() => {
    if (disabled && modelMenu) onCloseModelMenu();
  }, [disabled, modelMenu, onCloseModelMenu]);

  const runtimeLabel = runtimeId === 'kiro'
    ? 'Kiro'
    : agentStatus?.label ?? runtimeId ?? 'Runtime';
  const resolvedDefaultName = defaultModeId
    ? availableModes.find((mode) => mode.id === defaultModeId)?.name
    : undefined;
  const defaultAgentLabel = resolvedDefaultName ?? `${runtimeLabel} Default Agent`;
  const followsRuntimeDefault = !selectedPrimaryAgentId && !currentModeId;

  const primarySections: MenuSection[] = onSelectPrimaryAgent && onSelectDefaultAgent
    ? [
        {
          items: [{
            id: 'primary-default',
            label: defaultAgentLabel,
            glyph: followsRuntimeDefault ? '✓' : undefined,
            sublabel: `${runtimeLabel} default agent · follows runtime and model controls`,
            run: onSelectDefaultAgent,
          }],
        },
        ...(['workspace', 'global'] as const).map((scope) => ({
          label: scope === 'workspace' ? 'Workspace Agents' : 'Global Agents',
          items: primaryAgents.filter((agent) => agent.scope === scope).map((agent) => ({
            id: `primary-${agent.id}`,
            label: agent.name,
            glyph: selectedPrimaryAgentId === agent.id ? '✓' : undefined,
            sublabel: agent.runtimeSummary,
            run: () => onSelectPrimaryAgent(agent.id),
          })),
        })).filter((section) => section.items.length > 0),
        ...(primaryAgentsLoading ? [{ items: [{ id: 'primary-loading', label: 'Loading Custom Agents…', disabled: true, run: () => {} }] }] : []),
        ...(primaryAgentsError ? [{ items: [{ id: 'primary-error', label: primaryAgentsError, disabled: true, run: () => {} }] }] : []),
      ]
    : [];

  // Section header: "Kiro Agents" when the runtime is Kiro, neutral wording otherwise.
  const modesSectionLabel = (() => {
    if (primarySections.length === 0) return undefined;
    if (runtimeId === 'kiro') return 'Kiro Agents';
    if (agentStatus?.label) return `${agentStatus.label} Agents`;
    return 'Built-in Agents';
  })();

  return (
    <>
      {agentMenu && (
        <ContextMenu
          x={agentMenu.x}
          y={agentMenu.y}
          anchorBottom={agentMenu.anchorBottom}
          trigger={agentMenu.trigger}
          menuKind="agents"
          searchable
          sections={[
            ...primarySections,
            {
              label: modesSectionLabel,
              items:
                availableModes.length === 0
                  ? [{ id: 'loading', label: 'Loading…', disabled: true, run: () => {} }]
                  : availableModes.map((m) => ({
                      id: m.id,
                      label: m.name,
                      glyph: currentModeId === m.id ? '✓' : undefined,
                      sublabel: m.description || undefined,
                      run: () => {
                        if (m.id !== currentModeId) onSwitchAgent(m.id);
                      },
                    })),
            },
          ]}
          onClose={onCloseAgentMenu}
        />
      )}

      {modelMenu && !disabled && (
        <ComposerModelPicker
          anchor={modelMenu}
          agentStatus={agentStatus}
          resolvedBinding={resolvedBinding}
          catalogCapabilities={catalogCapabilities}
          providerModels={providerModels}
          providers={providers}
          modelsLoading={modelsLoading}
          modelsWaiting={modelsWaiting}
          modelsError={modelsError}
          onSwitchRuntime={onSwitchRuntime}
          onSaveProvider={onSaveProvider}
          onSaveModel={onSaveModel}
          onRetryModels={onRetryModels}
          onSaveReasoning={onSaveReasoning}
          onClose={onCloseModelMenu}
        />
      )}
    </>
  );
}
