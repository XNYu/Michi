import type { PageId } from './commands';

/** The four places the left rail switches between. Each has its own sidebar and main area. */
export type ShellArea = 'conversations' | 'spaces' | 'scheduled' | 'settings';

export const SHELL_AREAS: readonly ShellArea[] = ['conversations', 'spaces', 'scheduled', 'settings'];

export function areaForPage(page: PageId): ShellArea {
  if (page === 'spaces' || page === 'space') return 'spaces';
  if (page === 'scheduled') return 'scheduled';
  if (page === 'settings') return 'settings';
  return 'conversations';
}

/** What the Spaces area shows when its page is `spaces`: the global Home, one workspace's home, or All tasks. */
export type SpacesHomeTarget =
  | { kind: 'home' }
  | { kind: 'workspace'; workspaceId: string; backendConnectionId: string }
  | { kind: 'all-tasks' };

export const SPACES_HOME: SpacesHomeTarget = { kind: 'home' };
export const ALL_TASKS: SpacesHomeTarget = { kind: 'all-tasks' };

export type SettingsAreaSection = 'general' | 'runtime' | 'assistant' | 'meta-agent' | 'components' | 'appearance' | 'data';

export const SETTINGS_AREA_SECTIONS: ReadonlyArray<{ id: SettingsAreaSection; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'runtime', label: 'Runtime (global)' },
  { id: 'assistant', label: 'Assistant' },
  { id: 'meta-agent', label: 'Meta agent' },
  { id: 'components', label: 'Components' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'data', label: 'Data & backup' },
];

/**
 * The page an area opens on when entered from the rail. Conversations returns
 * to the last conversation page; Spaces always opens its Home; Scheduled and
 * Settings have a single page whose own selection is remembered separately.
 */
export function entryPageForArea(area: ShellArea, lastConversationPage: PageId): PageId {
  switch (area) {
    case 'conversations': return areaForPage(lastConversationPage) === 'conversations' ? lastConversationPage : 'home';
    case 'spaces': return 'spaces';
    case 'scheduled': return 'scheduled';
    case 'settings': return 'settings';
  }
}
