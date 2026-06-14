import { PROFILE_PAGE_ENABLED } from './featureFlags';
import { kbd } from '../lib/platform';

export type CommandGroup = 'nav' | 'action' | 'chat' | 'search-result';

export interface Command {
  id: string;
  group: CommandGroup;
  glyph: string;
  label: string;
  keys?: string;
  meta?: string;
  run: () => void;
}

export type PageId =
  | 'home'
  | 'dashboard'
  | 'map'
  | 'digest'
  | 'settings'
  | 'workspaces'
  | 'workspace-manage'
  | 'trash'
  | 'profile';

export interface CommandContext {
  activePage: PageId;
  selection: ReadonlySet<string>;
  /** Cross-project chat enumeration. Sourced from `selectAllChats` in chatStore. */
  allChats: Array<{ id: string; title: string; projectId: string; projectName: string }>;
  hasActiveProject: boolean;
  setPage: (p: PageId) => void;
  fanoutFromSelection: () => void;
  digestFromSelection: () => void;
  exportSelection: () => void;
  clearSelection: () => void;
  openChat: (id: string) => void;
  /** Switch the active workspace. Used by cross-project chat invocation in the palette
   *  and by global search row activation. Wired to `selectProject` in chatStore. */
  switchProject: (projectId: string) => void;
  createThread: () => void;
  activateTree: (treeId: string) => void;
  archiveTree: (treeId: string) => void;
  unarchiveTree: (treeId: string) => void;
  activeTreeId: string | null;
  liveTrees: Array<{ id: string; name: string }>;
  archivedTrees: Array<{ id: string; name: string }>;
  bypassPermissions: boolean;
  toggleBypassPermissions: () => void;
}

export function buildCommands(ctx: CommandContext): Command[] {
  const out: Command[] = [];
  if (ctx.hasActiveProject) {
    out.push(
      { id: 'nav.home',       group: 'nav', glyph: '◐', label: 'Go to home',            keys: kbd('mod', '0'), run: () => ctx.setPage('home') },
      { id: 'nav.map',        group: 'nav', glyph: '⎇', label: 'Open map',              keys: kbd('mod', 'M'), run: () => ctx.setPage('map') },
      { id: 'nav.digest',     group: 'nav', glyph: '§', label: 'Open workspace digest', keys: kbd('mod', 'D'), run: () => ctx.setPage('digest') },
      { id: 'nav.workspaces', group: 'nav', glyph: '▢', label: 'Switch workspace…',     keys: kbd('mod', 'O'), run: () => ctx.setPage('workspaces') },
      { id: 'nav.trash',      group: 'nav', glyph: '🗑', label: 'Open trash',            run: () => ctx.setPage('trash') },
      { id: 'nav.settings',   group: 'nav', glyph: '⚙', label: 'Open settings',         keys: kbd('mod', ','), run: () => ctx.setPage('settings') },
    );
    if (PROFILE_PAGE_ENABLED) {
      out.push(
        { id: 'nav.profile', group: 'nav', glyph: '◉', label: 'Open profile', keys: kbd('mod', 'P'), run: () => ctx.setPage('profile') },
      );
    }
    out.push({ id: 'thread.new', group: 'action', glyph: '+', label: 'New thread', keys: kbd('mod', 'T'), run: ctx.createThread });
    out.push({
      id: 'action.bypass-permissions',
      group: 'action',
      glyph: ctx.bypassPermissions ? '●' : '○',
      label: ctx.bypassPermissions ? 'Bypass permissions: ON' : 'Bypass permissions: OFF',
      run: ctx.toggleBypassPermissions,
    });
    for (const t of ctx.liveTrees) {
      out.push({ id: `thread.switch.${t.id}`, group: 'nav', glyph: '•', label: `Switch to thread ▸ ${t.name}`, run: () => ctx.activateTree(t.id) });
    }
    for (const t of ctx.archivedTrees) {
      out.push({ id: `thread.switch.archived.${t.id}`, group: 'nav', glyph: '▣', label: `Switch to archived thread ▸ ${t.name}`, run: () => ctx.activateTree(t.id) });
    }
    if (ctx.activeTreeId) {
      out.push({ id: 'thread.archive', group: 'action', glyph: '▣', label: 'Archive current thread', run: () => ctx.archiveTree(ctx.activeTreeId!) });
    }
  }
  if (ctx.selection.size >= 2) {
    out.push(
      { id: 'action.weave',  group: 'action', glyph: '⧉', label: `Weave ${ctx.selection.size} chats`,        run: ctx.fanoutFromSelection },
      { id: 'action.digest', group: 'action', glyph: '§', label: `Digest from ${ctx.selection.size} chats`, keys: kbd('shift', 'mod', 'D'), run: ctx.digestFromSelection },
      { id: 'action.export', group: 'action', glyph: '↓', label: `Export ${ctx.selection.size} selected`,                 run: ctx.exportSelection },
      { id: 'action.clear',  group: 'action', glyph: '×', label: 'Clear selection',                          keys: 'esc',  run: ctx.clearSelection },
    );
  }
  const chatsToShow = ctx.allChats.slice(0, 50);
  for (const c of chatsToShow) {
    out.push({
      id: `chat.${c.id}`,
      group: 'chat',
      glyph: '$',
      label: `${c.title} · ${c.projectName}`,
      run: () => {
        ctx.switchProject(c.projectId);
        ctx.openChat(c.id);
      },
    });
  }
  return out;
}

export function filterCommands(cmds: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return cmds;
  return cmds.filter((c) => c.label.toLowerCase().includes(q));
}
