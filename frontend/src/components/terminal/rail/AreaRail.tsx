import React from 'react';
import { Clock, Layers, MessageSquare, Settings } from 'lucide-react';
import { HoverTip } from '../../ui/Popover';
import type { ShellArea } from '../../../state/shellArea';
import './rail.css';

export const AREA_RAIL_WIDTH = 48;

export interface RailBadges {
  /** Things waiting on you on the Spaces Home. */
  spacesWaiting: number;
  /** First generation, or a conversation started in a Space, is running. */
  scheduledRunning: boolean;
  /** A conversation started in a Space finished and has not been opened. */
  conversationsDone: boolean;
  /** The Meta agent stopped (for example, its tool check failed). */
  settingsAlert: boolean;
  /** Memories waiting for approval in Settings › Memory. */
  memoryPending?: number;
}

export const NO_RAIL_BADGES: RailBadges = { spacesWaiting: 0, scheduledRunning: false, conversationsDone: false, settingsAlert: false };

const ITEMS: ReadonlyArray<{ area: ShellArea; label: string; short: string; Icon: typeof Clock }> = [
  { area: 'conversations', label: 'Conversations', short: 'Chats', Icon: MessageSquare },
  { area: 'spaces', label: 'Pages', short: 'Pages', Icon: Layers },
  { area: 'scheduled', label: 'Scheduled', short: 'Scheduled', Icon: Clock },
  { area: 'settings', label: 'Settings', short: 'Settings', Icon: Settings },
];

function describe(area: ShellArea, label: string, badges: RailBadges): { name: string; badge: React.ReactNode } {
  if (area === 'scheduled' && badges.scheduledRunning) return { name: `${label}, running`, badge: <i className="area-rail__dot" data-tone="run" /> };
  if (area === 'conversations' && badges.conversationsDone) return { name: `${label}, finished`, badge: <i className="area-rail__dot" data-tone="done" /> };
  if (area === 'settings' && badges.settingsAlert) return { name: `${label}, needs attention`, badge: <i className="area-rail__dot" data-tone="warn" /> };
  const pending = area === 'settings' ? badges.memoryPending ?? 0 : 0;
  if (pending > 0) {
    const memories = pending === 1 ? '1 memory' : `${pending} memories`;
    return { name: `${label}, ${memories} waiting for confirmation`, badge: <em className="area-rail__count" aria-hidden="true">{pending > 99 ? '99+' : pending}</em> };
  }
  return { name: label, badge: null };
}

/** The leftmost column: one button per area. Settings sits at the bottom. */
export function AreaRail({ area, onSelect, badges = NO_RAIL_BADGES, settingsOpen = false }: {
  area: ShellArea;
  onSelect: (area: ShellArea) => void;
  badges?: RailBadges;
  settingsOpen?: boolean;
}) {
  return (
    <nav className="area-rail" aria-label="Areas" style={{ width: AREA_RAIL_WIDTH }}>
      {ITEMS.map(({ area: id, label, Icon }) => {
        const { name, badge } = describe(id, label, badges);
        return (
          <React.Fragment key={id}>
            {id === 'settings' && <span className="area-rail__spacer" aria-hidden="true" />}
            <HoverTip label={label} delayMs={300} side="right">
              <button
                type="button"
                className="area-rail__btn"
                data-area={id}
                aria-label={name}
                aria-current={id !== 'settings' && area === id ? 'page' : undefined}
                aria-haspopup={id === 'settings' ? 'dialog' : undefined}
                aria-expanded={id === 'settings' ? settingsOpen : undefined}
                onClick={() => onSelect(id)}
              >
                <Icon size={17} strokeWidth={1.5} aria-hidden="true" />
                {badge}
              </button>
            </HoverTip>
          </React.Fragment>
        );
      })}
    </nav>
  );
}

/** The same areas as a labelled row, for the top of the phone drawer, which has no rail. */
export function AreaTabs({ area, onSelect, badges = NO_RAIL_BADGES, settingsOpen = false }: {
  area: ShellArea;
  onSelect: (area: ShellArea) => void;
  badges?: RailBadges;
  settingsOpen?: boolean;
}) {
  return (
    <nav className="area-tabs" aria-label="Areas">
      {ITEMS.map(({ area: id, label, short, Icon }) => {
        const { name, badge } = describe(id, label, badges);
        return (
          <button
            key={id}
            type="button"
            className="area-tabs__btn"
            data-area={id}
            aria-label={name}
            aria-current={id !== 'settings' && area === id ? 'page' : undefined}
            aria-haspopup={id === 'settings' ? 'dialog' : undefined}
            aria-expanded={id === 'settings' ? settingsOpen : undefined}
            onClick={() => onSelect(id)}
          >
            <span className="area-tabs__icon">
              <Icon size={18} strokeWidth={1.5} aria-hidden="true" />
              {badge}
            </span>
            <span aria-hidden="true">{short}</span>
          </button>
        );
      })}
    </nav>
  );
}

export default AreaRail;
