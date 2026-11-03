import React from 'react';
import { Cpu } from 'lucide-react';
import { usePhoneLayout } from '../../hooks/usePhoneLayout';
import type { AgentCapabilities, AgentModelInfo, AgentProviderInfo, AgentStatus } from '../../services/api';
import type { ResolvedNodeBinding } from '../../state/nodeBindingResolution';
import { ChevronRightIcon } from './icons';
import { COMPOSER_ICON_STROKE, REASONING_LABELS, composerIconSize, composerMenusOpenBelow, type PaneMenuAnchor } from './PaneComposerToolbarLeft';
import './ComposerModelPicker.css';
import { resolveComposerReasoning } from './composerReasoning';
import { composerModelLabel } from './composerModelLabel';

const EFFORT_INITIALS: Record<string, string> = { minimal: 'Min', low: 'L', medium: 'M', high: 'H', xhigh: 'XH', max: 'Max' };

interface ComposerModelTriggerProps {
  toolbarTier: 0 | 1 | 2;
  agentStatus: AgentStatus | null;
  resolvedBinding: ResolvedNodeBinding;
  catalogCapabilities: AgentCapabilities | null;
  providerModels: readonly AgentModelInfo[];
  providers?: readonly AgentProviderInfo[];
  isStreaming: boolean;
  /** Shows the binding without offering a picker (the ⌘J assistant's: Settings owns it). */
  locked?: boolean;
  modelMenuOpen?: boolean;
  onOpenModelMenu: (anchor: PaneMenuAnchor) => void;
  /** What switching the model also ends (e.g. a running workflow). */
  switchHint?: string;
}

export function ComposerModelTrigger({ toolbarTier, agentStatus, resolvedBinding, catalogCapabilities, providerModels, providers, isStreaming, locked = false, modelMenuOpen = false, onOpenModelMenu, switchHint }: ComposerModelTriggerProps) {
  const caps = catalogCapabilities ?? (resolvedBinding.runtime === agentStatus?.runtime ? agentStatus.capabilities : undefined);
  const runtimeLabel = agentStatus?.availableRuntimes?.find((runtime) => runtime.id === resolvedBinding.runtime)?.label || resolvedBinding.runtime;
  const hasModel = caps?.providerModels || caps?.models || resolvedBinding.model;
  const modelLabel = composerModelLabel(resolvedBinding.runtime, resolvedBinding.model, providerModels);
  const effort = resolveComposerReasoning(resolvedBinding, agentStatus, catalogCapabilities, providerModels, providers);
  const effortLabel = effort.adjustable ? REASONING_LABELS[effort.value ?? ''] ?? effort.value : undefined;
  // A locked binding cannot be switched here, so there is nothing to warn about.
  const hint = locked ? undefined : switchHint;
  const phone = usePhoneLayout();

  return (
    <button type="button" className={`t-toolbar-chip composer-model-trigger${phone ? ' is-icon' : ''}`} data-compact={toolbarTier > 0 || undefined}
      aria-label={`${locked ? 'Model' : 'Model settings'}: ${runtimeLabel}, ${modelLabel}${effortLabel ? `, ${effortLabel} effort` : ''}${hint ? `. ${hint}` : ''}`}
      title={[[runtimeLabel, modelLabel, effortLabel].filter(Boolean).join(' · '), hint].filter(Boolean).join('. ')}
      aria-haspopup={locked ? undefined : 'dialog'} aria-expanded={locked ? undefined : modelMenuOpen} disabled={isStreaming || locked}
      onClick={(event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        onOpenModelMenu({ x: rect.right, y: rect.bottom + 6, anchorBottom: rect.top - 6, preferBelow: composerMenusOpenBelow(event.currentTarget),
          align: 'end', trigger: event.currentTarget, keyboard: event.detail === 0 });
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        event.stopPropagation();
        if (!modelMenuOpen) event.currentTarget.click();
      }}>
      {phone ? <>
        <Cpu size={composerIconSize(true)} strokeWidth={COMPOSER_ICON_STROKE} absoluteStrokeWidth aria-hidden="true" />
        {effortLabel && <span className="composer-model-trigger-effort" aria-hidden="true">{EFFORT_INITIALS[effort.value ?? ''] ?? effortLabel.charAt(0)}</span>}
      </> : <>
        <span className="t-chip-label">{hasModel ? modelLabel : runtimeLabel}</span>
        {effortLabel && <span className="composer-model-trigger-effort">{effortLabel}</span>}
        {!locked && <ChevronRightIcon size={12} className="composer-model-chevron" />}
      </>}
    </button>
  );
}
