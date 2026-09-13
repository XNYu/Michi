import React from 'react';
import type { AgentCapabilities, AgentModelInfo, AgentProviderInfo, AgentStatus } from '../../services/api';
import type { ResolvedNodeBinding } from '../../state/nodeBindingResolution';
import { ChevronRightIcon } from './icons';
import { REASONING_LABELS, type PaneMenuAnchor } from './PaneComposerToolbarLeft';
import './ComposerModelPicker.css';
import { resolveComposerReasoning } from './composerReasoning';

interface ComposerModelTriggerProps {
  toolbarTier: 0 | 1 | 2;
  agentStatus: AgentStatus | null;
  resolvedBinding: ResolvedNodeBinding;
  catalogCapabilities: AgentCapabilities | null;
  providerModels: readonly AgentModelInfo[];
  providers?: readonly AgentProviderInfo[];
  isStreaming: boolean;
  modelMenuOpen?: boolean;
  onOpenModelMenu: (anchor: PaneMenuAnchor) => void;
}

export function ComposerModelTrigger({ toolbarTier, agentStatus, resolvedBinding, catalogCapabilities, providerModels, providers, isStreaming, modelMenuOpen = false, onOpenModelMenu }: ComposerModelTriggerProps) {
  const caps = catalogCapabilities ?? (resolvedBinding.runtime === agentStatus?.runtime ? agentStatus.capabilities : undefined);
  const runtimeLabel = agentStatus?.availableRuntimes?.find((runtime) => runtime.id === resolvedBinding.runtime)?.label || resolvedBinding.runtime;
  const hasModel = caps?.providerModels || caps?.models || resolvedBinding.model;
  const modelLabel = providerModels.find((model) => model.id === resolvedBinding.model)?.label || resolvedBinding.model || 'Default model';
  const effort = resolveComposerReasoning(resolvedBinding, agentStatus, catalogCapabilities, providerModels, providers);
  const effortLabel = effort.adjustable ? REASONING_LABELS[effort.value ?? ''] ?? effort.value : undefined;

  return (
    <button type="button" className="t-toolbar-chip composer-model-trigger" data-compact={toolbarTier > 0 || undefined}
      aria-label={`Model settings: ${runtimeLabel}, ${modelLabel}${effortLabel ? `, ${effortLabel} effort` : ''}`}
      title={[runtimeLabel, modelLabel, effortLabel].filter(Boolean).join(' · ')}
      aria-haspopup="dialog" aria-expanded={modelMenuOpen} disabled={isStreaming}
      onClick={(event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        onOpenModelMenu({ x: rect.right, y: rect.bottom + 6, anchorBottom: rect.top - 6, align: 'end', trigger: event.currentTarget, keyboard: event.detail === 0 });
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        event.stopPropagation();
        if (!modelMenuOpen) event.currentTarget.click();
      }}>
      <span className="t-chip-label">{hasModel ? modelLabel : runtimeLabel}</span>
      {effortLabel && <span className="composer-model-trigger-effort">{effortLabel}</span>}
      <ChevronRightIcon size={12} className="composer-model-chevron" />
    </button>
  );
}
