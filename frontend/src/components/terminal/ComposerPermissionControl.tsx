import React, { useState } from 'react';
import type { ChatPermissionMode } from 'michi-shared';
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

/** Same chip, anchor and ContextMenu used by the Composer agent picker. */
export function ComposerPermissionControl({ mode, runtimeIds, onChange, disabled = false, compact = false, scope = 'chat', apiBase = activeBackendApiBase() }: {
  apiBase?: string;
  mode: ChatPermissionMode;
  /** One chat's runtime, or all registered runtimes for the global setting. */
  runtimeIds: readonly string[];
  onChange: (mode: ChatPermissionMode) => void | Promise<void>;
  disabled?: boolean;
  compact?: boolean;
  scope?: 'chat' | 'global';
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
  const displayedMode = mode === 'yolo' && !supportsYolo ? 'trust' : mode;
  const choices = PERMISSION_CHOICES.filter((choice) => supportsYolo || choice.mode !== 'yolo');
  const label = PERMISSION_CHOICES.find((choice) => choice.mode === displayedMode)?.label ?? 'Ask';
  return <>
    <button type="button" className="t-toolbar-chip" data-icononly={compact || undefined}
      aria-label={`Permissions: ${label}`} title={`Permissions: ${label} · ${scope === 'global' ? 'all chats' : 'this chat'}`}
      aria-haspopup="menu" aria-expanded={!!anchor} disabled={disabled || saving}
      onClick={(event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        setAnchor(anchor ? null : { x: rect.left, y: rect.bottom + 6, anchorBottom: rect.top - 6, trigger: event.currentTarget });
      }} onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (!anchor) event.currentTarget.click();
        }
      }}>
      {displayedMode === 'ask' ? <ShieldIcon /> : <ShieldOffIcon />}
      <span className="t-chip-label">{saving ? 'Saving…' : label}</span>
    </button>
    {anchor && !disabled && <ContextMenu {...anchor} menuKind="agents" width={300}
      onClose={() => setAnchor(null)} sections={[{ label: scope === 'global' ? 'Permissions · all chats' : 'Permissions · this chat', items: choices.map((choice) => ({
        id: choice.mode, label: choice.label,
        sublabel: choice.mode === 'trust' && !supportsYolo ? 'Approve tool requests automatically.' : choice.description,
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
