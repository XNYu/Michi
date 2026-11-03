import React from 'react';
import { AtSign, Plus } from 'lucide-react';
import { usePhoneLayout } from '../../hooks/usePhoneLayout';
import type { AgentStatus, SessionMode } from '../../services/api';
import { AgentIcon, ChevronRightIcon } from './icons';

/** Icon-only toolbar buttons: 16px on desktop, 18px on a phone, one 1.6px stroke. */
export const COMPOSER_ICON_STROKE = 1.6;
export const composerIconSize = (phone: boolean) => (phone ? 18 : 16);

export const REASONING_LABELS: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/** Toolbar menus open downward, off the draft, where the toolbar is near the
 *  top of the screen: the tray under the composer, and Home, whose composer
 *  sits at the top of the page. Elsewhere they open above. */
export const composerMenusOpenBelow = (trigger: Element) => !!trigger.closest('.composer-tray, .home-compose');

export interface PaneMenuAnchor {
  x: number;
  y: number;
  anchorBottom?: number;
  /** Open below the trigger, flipping above only when it does not fit
   *  (composerMenusOpenBelow). */
  preferBelow?: boolean;
  align?: 'start' | 'end';
  trigger?: HTMLButtonElement;
  keyboard?: boolean;
}

interface PaneComposerToolbarLeftProps {
  canAttach: boolean;
  /** Show + (attach) and @ (mention). Off where neither does anything (the Michi assistant). */
  contextTools?: boolean;
  toolbarTier: 0 | 1 | 2;
  enableAgentChip?: boolean;
  currentMode?: SessionMode;
  currentModeId?: string;
  availableModesCount: number;
  agentStatus: AgentStatus | null;
  onPickFile: () => void;
  onInsertMentionTrigger: () => void;
  /** Called on every agent-chip press; the owner toggles the menu. */
  onOpenAgentMenu: (anchor: PaneMenuAnchor) => void;
  agentMenuOpen?: boolean;
}

export function PaneComposerToolbarLeft({
  canAttach,
  contextTools = true,
  toolbarTier,
  enableAgentChip = true,
  currentMode,
  currentModeId,
  availableModesCount,
  agentStatus,
  onPickFile,
  onInsertMentionTrigger,
  onOpenAgentMenu,
  agentMenuOpen = false,
}: PaneComposerToolbarLeftProps) {
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
  const iconSize = composerIconSize(usePhoneLayout());

  return (
    <>
      {contextTools && (
        <>
          <span
            className="t-toolbar-chip composer-attach"
            title={canAttach ? 'Attach file' : 'Open a workspace to attach files'}
            aria-disabled={!canAttach || undefined}
            onClick={(e) => {
              e.stopPropagation();
              if (canAttach) onPickFile();
            }}
            style={{ flexShrink: 0, padding: 0, width: 'var(--composer-chip-height, 30px)', justifyContent: 'center', lineHeight: 1 }}
          >
            <Plus size={iconSize} strokeWidth={COMPOSER_ICON_STROKE} absoluteStrokeWidth aria-hidden="true" />
          </span>

          <span
            className="t-toolbar-chip composer-mention"
            title="Mention context or node"
            onClick={onInsertMentionTrigger}
            style={{ flexShrink: 0, padding: 0, width: 'var(--composer-chip-height, 30px)', justifyContent: 'center', lineHeight: 1 }}
          >
            <AtSign size={iconSize} strokeWidth={COMPOSER_ICON_STROKE} absoluteStrokeWidth aria-hidden="true" />
          </span>
        </>
      )}

      {showAgentChip && (
        <button
          type="button"
          className="t-toolbar-chip"
          data-icononly={toolbarTier >= 1 ? 'true' : undefined}
          title={`Switch agent — ${currentMode?.name ?? currentModeId ?? 'agent'}`}
          aria-haspopup="menu"
          aria-expanded={agentMenuOpen}
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            onOpenAgentMenu({ x: r.left, y: r.bottom + 6, anchorBottom: r.top - 6, preferBelow: composerMenusOpenBelow(e.currentTarget), trigger: e.currentTarget });
          }}
        >
          {/* Chip icons follow the 11px label (14px); ⌄ marks it as a picker, like the model chip. */}
          <AgentIcon size={14} />
          <span className="t-chip-label">{currentMode?.name ?? currentModeId ?? 'agent'}</span>
          <ChevronRightIcon size={12} className="composer-agent-chevron" />
        </button>
      )}
    </>
  );
}
