import { SHORTCUT_GROUPS } from '../pages/settings/ShortcutsPane';
import { SETTINGS_PAGES, type SettingsPage } from './settingsPages';

/**
 * One setting the Settings window can find. `label` is the setting's name as
 * its page shows it, so a result can reveal it on that page; `keywords` hold
 * other words people search with (preference keys, option names).
 */
export interface SettingsSearchEntry {
  page: SettingsPage;
  /** The group heading the setting sits under on its page. */
  group?: string;
  label: string;
  description?: string;
  keywords?: readonly string[];
}

const entries = (page: SettingsPage, group: string | undefined, items: ReadonlyArray<Omit<SettingsSearchEntry, 'page' | 'group'>>) =>
  items.map((item) => ({ page, group, ...item }));

export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchEntry[] = [
  ...entries('runtime', 'Model', [
    { label: 'Runtime', description: 'Applies to new chats. Existing chats keep the runtime they started with.', keywords: ['claude', 'kiro', 'codex', 'pi', 'crew', 'agent'] },
    { label: 'Reasoning effort', description: 'Models that support it receive this preference.', keywords: ['thinking', 'effort', 'low', 'high', 'max'] },
    { label: 'Native Resume', description: 'Reopen chats in the runtime’s own session.', keywords: ['resume', 'session'] },
    { label: 'Native Fork', description: 'Branch chats in the runtime’s own session.', keywords: ['fork', 'branch', 'session'] },
  ]),
  ...entries('runtime', 'Web search', [{ label: 'Search provider', description: 'Searches run from the backend.', keywords: ['web', 'search', 'jina', 'api key'] }]),
  ...entries('runtime', 'Follow-ups', [{ label: 'Generate follow-up questions', keywords: ['suggestions', 'follow up'] }]),
  ...entries('runtime', 'Permissions', [
    { label: 'Use global permissions', description: 'One permission mode for all chats, or one per chat.', keywords: ['ask', 'trust', 'yolo', 'approve', 'approval'] },
  ]),
  ...entries('meta-agent', 'Runtime', [
    { label: 'Follow global settings', description: 'The Meta agent uses the global runtime and model.', keywords: ['meta agent runtime', 'custom'] },
  ]),
  ...entries('meta-agent', 'Reading', [
    { label: 'Background updates', description: 'Checks every workspace for new conversations every 60 seconds.', keywords: ['pause', 'meta agent'] },
    { label: 'First run', description: 'How far back the Meta agent reads a workspace the first time.', keywords: ['days', 'history'] },
  ]),
  ...entries('meta-agent', 'Writing', [
    { label: 'Workspace homes', description: 'Keeps each workspace’s home page up to date.', keywords: ['pages', 'home page'] },
    { label: 'Pages home', description: 'Keeps the overview on the Pages Home up to date.', keywords: ['overview'] },
  ]),
  ...entries('memory', 'Memory', [
    { label: 'Memory mode', description: 'Off, explicit only, or automatic.', keywords: ['remember', 'memories', 'forget', 'automatic memory', 'explicit'] },
  ]),
  ...entries('memory', undefined, [
    { label: 'Saved memories', description: 'Search, edit, delete or change the scope of what agents remember.', keywords: ['remember', 'preferences', 'conventions', 'forget', 'global', 'workspace'] },
    { label: 'Waiting for confirmation', description: 'Approve or reject memories agents suggested.', keywords: ['pending', 'approve', 'reject', 'memories'] },
    { label: 'Automatic memory', description: 'Pause or resume suggestions from your conversations.', keywords: ['extraction', 'pause', 'resume', 'tokens'] },
  ]),
  ...entries('machines', 'Connected machines', [
    { label: 'Connected machines', description: 'Work locally or connect a remote machine.', keywords: ['remote', 'ssh', 'devdesktop', 'dev desktop', 'server', 'connect remote', 'tunnel'] },
  ]),
  ...entries('machines', 'Phone access', [
    { label: 'Phone access', description: 'Open this machine’s Michi on your phone.', keywords: ['mobile', 'qr', 'tunnel', 'sign-in link', 'connect phone'] },
  ]),
  ...entries('appearance', undefined, [
    { label: 'Home', description: 'Pages recommendations on Home.', keywords: ['recommendations', 'composer'] },
    { label: 'Palette', description: 'Bone, Slate, Monokai or Gruvbox.', keywords: ['theme', 'dark', 'light', 'bone', 'slate', 'monokai', 'gruvbox', 'color', 'theme.palette'] },
    { label: 'Accent hue', description: 'The highlight color of the current palette.', keywords: ['color', 'colour', 'rust', 'theme.accent'] },
    { label: 'Sidebar threads per workspace', keywords: ['sidebar', 'threads', 'theme.sidebarThreadLimit'] },
    { label: 'Focus dimming', description: 'Dims panes you are not working in.', keywords: ['dim', 'panes', 'theme.focusDim'] },
    { label: 'Reduce motion', description: 'Suppress animations (drawer slides, pane transitions).', keywords: ['animation', 'motion', 'a11y.reduceMotion', 'accessibility'] },
    { label: 'Single-page mode', description: 'One pane at a time; the thread’s other panes become tabs.', keywords: ['tabs', 'panes', 'layout.singlePage'] },
  ]),
  ...entries('appearance', 'Advanced', [
    { label: 'Pane width mode', keywords: ['panes', 'width', 'layout.paneWidthMode'] },
    { label: 'Pane animation', description: 'How a pane enters and leaves.', keywords: ['motion', 'animation', 'motion.spawn'] },
    { label: 'Default pane width', keywords: ['panes', 'width', 'layout.paneWidth'] },
    { label: 'Single-pane reading width', keywords: ['reading', 'width', 'layout.singlePaneWidth'] },
    { label: 'Corner radius', keywords: ['rounded', 'radius', 'theme.cornerRadius'] },
    { label: 'Sidebar row style', keywords: ['sidebar', 'cards', 'theme.sidebarRowStyle'] },
    { label: 'Interface font', keywords: ['font', 'typeface', 'geist', 'inter', 'theme.uiFont'] },
    { label: 'Message font', keywords: ['font', 'serif', 'theme.messageFont'] },
    { label: 'Message size', keywords: ['font size', 'text size', 'theme.messageFontSize'] },
    { label: 'Composer size', keywords: ['font size', 'text size', 'theme.composerFontSize'] },
    { label: 'Sidebar density', keywords: ['sidebar', 'compact', 'theme.sidebarDensity'] },
    { label: 'Sidebar edge padding', keywords: ['sidebar', 'padding', 'theme.sidebarInset'] },
    { label: 'Sidebar timestamps', description: 'Show last-active time on thread rows.', keywords: ['sidebar', 'time', 'theme.sidebarTimestamps'] },
    { label: 'Code wrap', description: 'Wrap long lines instead of horizontal scroll.', keywords: ['code', 'wrap', 'theme.codeWrap'] },
    { label: 'Chrome rules', description: 'Hairline rules between panes.', keywords: ['lines', 'borders', 'theme.rules'] },
  ]),
  ...entries('notifications', undefined, [
    { label: 'Notifications', description: 'All, approval requests only, or off.', keywords: ['notify', 'alerts', 'approval'] },
  ]),
  ...entries('links', 'Browser', [
    { label: 'Open links in', description: 'Michi Browser or your system browser.', keywords: ['browser', 'links', 'open_url', 'external'] },
  ]),
  ...entries('backup', undefined, [
    { label: 'Backup and restore', description: 'Export workspaces, conversations and Agent data, or restore them.', keywords: ['export', 'import', 'restore', 'json'] },
  ]),
  ...entries('scheduled', 'Background', [
    { label: 'Default scheduled job thread', description: 'One ongoing thread, or a new thread each run.', keywords: ['scheduled', 'jobs', 'cron'] },
    { label: 'Keep Michi running in the background', description: 'Scheduled jobs keep running after you quit.', keywords: ['background', 'service', 'login'] },
  ]),
  ...SHORTCUT_GROUPS.flatMap((group) => group.bindings.map((binding) => ({
    page: 'shortcuts' as const, group: group.title, label: binding.label, description: binding.keys, keywords: ['shortcut', 'keyboard'],
  }))),
  ...entries('account', undefined, [{ label: 'Account', description: 'Who is signed in, and Sign out.', keywords: ['sign out', 'email'] }]),
];

export interface SettingsSearchResult extends SettingsSearchEntry {
  /** "App › Appearance › Advanced": where the setting is. */
  path: string;
}

const normalize = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

/**
 * Settings whose name, description, page or keywords contain every word of
 * the query, names first: a name that starts with the query, then one that
 * contains it, then the rest.
 */
export function searchSettings(query: string, pages: readonly SettingsPage[], groupOf: (page: SettingsPage) => string): SettingsSearchResult[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const allowed = new Set(pages);
  const scored: Array<{ result: SettingsSearchResult; score: number; order: number }> = [];
  SETTINGS_SEARCH_INDEX.forEach((entry, order) => {
    if (!allowed.has(entry.page)) return;
    const page = SETTINGS_PAGES[entry.page].label;
    const label = normalize(entry.label);
    const haystack = normalize([entry.label, entry.description, page, entry.group, ...(entry.keywords ?? [])].filter(Boolean).join(' '));
    if (!words.every((word) => haystack.includes(word))) return;
    const phrase = words.join(' ');
    const score = label.startsWith(phrase) ? 0 : label.includes(phrase) ? 1 : words.every((word) => label.includes(word)) ? 2 : 3;
    const path = [groupOf(entry.page), page, entry.group && entry.group !== page && entry.group !== entry.label ? entry.group : null].filter(Boolean).join(' › ');
    scored.push({ result: { ...entry, path }, score, order });
  });
  return scored.sort((a, b) => a.score - b.score || a.order - b.order).map(({ result }) => result);
}
