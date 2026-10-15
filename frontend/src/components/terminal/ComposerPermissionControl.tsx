import React, { useState } from 'react';
import type { ChatPermissionMode } from 'michi-shared';
import ContextMenu from '../ContextMenu';
import { ShieldIcon, ShieldOffIcon } from './icons';
import type { PaneMenuAnchor } from './PaneComposerToolbarLeft';
import { toast } from 'sonner';

export const PERMISSION_CHOICES: ReadonlyArray<{ mode: ChatPermissionMode; label: string; description: string }> = [
  { mode: 'ask', label: 'Ask', description: 'Ask before changes and tools that require approval. Read-only tools may run automatically.' },
  { mode: 'trust', label: 'Trust', description: 'Approve tool requests automatically. Keep the runtime’s existing sandbox.' },
  { mode: 'yolo', label: 'YOLO', description: 'Approve tools automatically and use full access where the runtime supports it.' },
];

/** Same chip, anchor and ContextMenu used by the Composer agent picker. */
export function ComposerPermissionControl({ mode, onChange, disabled = false, compact = false, scope = 'chat' }: {
  mode: ChatPermissionMode;
  onChange: (mode: ChatPermissionMode) => void | Promise<void>;
  disabled?: boolean;
  compact?: boolean;
  scope?: 'chat' | 'global';
}) {
  const [anchor, setAnchor] = useState<PaneMenuAnchor | null>(null);
  const [saving, setSaving] = useState(false);
  const label = PERMISSION_CHOICES.find((choice) => choice.mode === mode)?.label ?? 'Ask';
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
      {mode === 'ask' ? <ShieldIcon /> : <ShieldOffIcon />}
      <span className="t-chip-label">{saving ? 'Saving…' : label}</span>
    </button>
    {anchor && !disabled && <ContextMenu {...anchor} menuKind="agents" width={300}
      onClose={() => setAnchor(null)} sections={[{ label: scope === 'global' ? 'Permissions · all chats' : 'Permissions · this chat', items: PERMISSION_CHOICES.map((choice) => ({
        id: choice.mode, label: choice.label, sublabel: choice.description, glyph: choice.mode === mode ? '✓' : undefined,
        run: () => {
          setSaving(true);
          void Promise.resolve().then(() => onChange(choice.mode))
            .catch((error: unknown) => toast.error(error instanceof Error ? error.message : 'Failed to save permissions'))
            .finally(() => setSaving(false));
        },
      })) }]} />}
  </>;
}
