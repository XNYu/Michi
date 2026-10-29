import React, { useState } from 'react';
import type { ChatPermissionChoice, ChatPermissionMode } from 'michi-shared';
import { useCrewIntegration } from './CrewIntegrationStatus';
import { activeBackendApiBase } from '../../config/backendConnections';
import ContextMenu from '../ContextMenu';
import { ShieldIcon, ShieldOffIcon } from './icons';
import type { PaneMenuAnchor } from './PaneComposerToolbarLeft';
import { toast } from 'sonner';
import { supportsChatYolo } from '../../lib/chatPermissionModes';

export const PERMISSION_CHOICES: ReadonlyArray<{ mode: ChatPermissionMode; label: string; description: string }> = [
  { mode: 'ask', label: 'Ask', description: 'Ask before changes and tools that require approval. Read-only tools may run automatically.' },
  { mode: 'trust', label: 'Trust', description: 'Approve tool requests automatically. Keep the runtime’s existing sandbox.' },
  { mode: 'yolo', label: 'YOLO', description: 'Approve tools automatically and use full access where the runtime supports it.' },
];

/** Kiro V3's own approval on top of Ask; listed after Ask where a runtime supports it. */
export const APPROVE_FOR_ME_CHOICE = {
  mode: 'approve' as const, label: 'Approve for me',
  description: 'Kiro approves routine work, blocks risky actions and asks when unsure. Workspace edits and read-only shell run automatically.',
};

const ALL_CHOICES: ReadonlyArray<{ mode: ChatPermissionChoice; label: string; description: string }> = [
  PERMISSION_CHOICES[0], APPROVE_FOR_ME_CHOICE, ...PERMISSION_CHOICES.slice(1),
];

/** Same chip, anchor and ContextMenu used by the Composer agent picker. */
export function ComposerPermissionControl({ mode, runtimeIds, approveForMeRuntimeIds = [], onChange, disabled = false, compact = false, scope = 'chat', apiBase = activeBackendApiBase(), yoloRestartHint }: {
  apiBase?: string;
  mode: ChatPermissionChoice;
  /** One chat's runtime, or all registered runtimes for the global setting. */
  runtimeIds: readonly string[];
  /** Runtimes offering Approve for me (approveForMeRuntimeIds of the agent status). */
  approveForMeRuntimeIds?: readonly string[];
  onChange: (mode: ChatPermissionChoice) => void | Promise<void>;
  disabled?: boolean;
  compact?: boolean;
  scope?: 'chat' | 'global';
  /**
   * What switching into or out of YOLO also does (Claude restarts on the
   * next message, ending a running workflow); shown on those choices.
   */
  yoloRestartHint?: string;
}) {
  const [anchor, setAnchor] = useState<PaneMenuAnchor | null>(null);
  const [saving, setSaving] = useState(false);
  const crewOnly = runtimeIds.length === 1 && runtimeIds[0] === 'crew';
  const crewStatus = useCrewIntegration(apiBase, crewOnly);
  if (crewOnly && (!crewStatus?.approvals || !crewStatus.mcpDeclared || !crewStatus.mcpRouted || crewStatus.updateRequired)) {
    const label = !crewStatus ? 'Checking Crew setup…' : crewStatus.unavailable ? 'Crew setup unavailable' : crewStatus.updateRequired ? 'Sync Crew App' : 'Crew setup required';
    const detail = !crewStatus ? 'Checking required Michi MCP and approval setup.' : crewStatus.unavailable
      ? 'Could not verify Crew setup. Check the Michi backend connection and retry.'
      : crewStatus.updateRequired ? `Crew App ${crewStatus.installedVersion ?? 'unknown'} is older than ${crewStatus.expectedVersion}. Update Michi, then Sync michi-crew-runtime in Crew Apps. Refresh custom or temporary sources with the compatibility helper first.`
      : 'Install the crew-app directory from your Michi installation in Crew, grant sessionApproval, enable and approve Michi MCP Stub / Routed, then restart the Gateway. Chats and approvals stay in Michi.';
    return <span className="t-toolbar-chip" role="status" title={detail}>{label}</span>;
  }
  const supportsYolo = runtimeIds.some(supportsChatYolo);
  const supportsApprove = runtimeIds.some((id) => approveForMeRuntimeIds.includes(id));
  // A runtime without Approve for me runs it as Ask, so it shows Ask.
  const displayedMode: ChatPermissionChoice = mode === 'yolo' && !supportsYolo ? 'trust' : mode === 'approve' && !supportsApprove ? 'ask' : mode;
  const choices = ALL_CHOICES.filter((choice) => (supportsYolo || choice.mode !== 'yolo') && (supportsApprove || choice.mode !== 'approve'));
  const label = ALL_CHOICES.find((choice) => choice.mode === displayedMode)?.label ?? 'Ask';
  // Only the global setting can reach runtimes without it; they use Ask.
  const approveScopeNote = scope === 'global' && runtimeIds.some((id) => !approveForMeRuntimeIds.includes(id)) ? ' Other runtimes use Ask.' : '';
  const crossesYolo = (next: ChatPermissionChoice) => (next === 'yolo') !== (displayedMode === 'yolo');
  const baseTitle = `Permissions: ${label} · ${scope === 'global' ? 'all chats' : 'this chat'}`;
  return <>
    {/* Every label here is a short word, and "A…" says less than the shield
        alone, so this chip keeps its width and a crowded toolbar takes the
        space from the model name instead. Callers switch it to icon-only. */}
    <button type="button" className="t-toolbar-chip" data-icononly={compact || undefined} style={{ flexShrink: 0 }}
      aria-label={`Permissions: ${label}`} title={yoloRestartHint && supportsYolo ? `${baseTitle}. ${yoloRestartHint}` : baseTitle}
      aria-haspopup="menu" aria-expanded={!!anchor} disabled={disabled || saving}
      onClick={(event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        setAnchor(anchor ? null : { x: rect.left, y: rect.bottom + 6, anchorBottom: rect.top - 6, trigger: event.currentTarget,
          preferBelow: !!event.currentTarget.closest('.composer-tray') });
      }} onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (!anchor) event.currentTarget.click();
        }
      }}>
      {displayedMode === 'ask' || displayedMode === 'approve' ? <ShieldIcon /> : <ShieldOffIcon />}
      <span className="t-chip-label">{saving ? 'Saving…' : label}</span>
    </button>
    {anchor && !disabled && <ContextMenu {...anchor} menuKind="agents" width={300}
      onClose={() => setAnchor(null)} sections={[{ label: scope === 'global' ? 'Permissions · all chats' : 'Permissions · this chat', items: choices.map((choice) => ({
        id: choice.mode, label: choice.label,
        sublabel: [
          choice.mode === 'trust' && !supportsYolo ? 'Approve tool requests automatically.'
            : choice.mode === 'approve' ? `${choice.description}${approveScopeNote}` : choice.description,
          yoloRestartHint && supportsYolo && crossesYolo(choice.mode) ? yoloRestartHint : undefined,
        ].filter(Boolean).join(' '),
        glyph: choice.mode === displayedMode ? '✓' : undefined,
        run: () => {
          setSaving(true);
          void Promise.resolve().then(() => onChange(choice.mode))
            .catch((error: unknown) => toast.error(error instanceof Error ? error.message : 'Failed to save permissions'))
            .finally(() => setSaving(false));
        },
      })) }]} />}
  </>;
}
