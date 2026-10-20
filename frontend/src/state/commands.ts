import { PROFILE_PAGE_ENABLED } from './featureFlags';
import { kbd } from '../lib/platform';

export type CommandGroup = 'nav' | 'action' | 'workspace' | 'chat' | 'search-result';

/** Leading icon for a palette row. Names map to the SVG set in
 *  components/terminal/icons.tsx (see commandIcons.tsx); this module stays
 *  JSX-free. */
export type CommandIcon =
  | 'agent' | 'home' | 'desk' | 'branches' | 'map' | 'digest' | 'workspace' | 'trash'
  | 'archive' | 'settings' | 'profile' | 'plus' | 'shield' | 'shield-off'
  | 'thread' | 'weave' | 'export' | 'close' | 'chat';

export interface Command {
  id: string;
  group: CommandGroup;
  icon: CommandIcon;
  label: string;
  keys?: string;
  meta?: string;
  run: () => void;
}

export type PageId =
  | 'home'
  | 'desk'
  | 'desk-threads'
  | 'desk-project'
  | 'dashboard'
  | 'branches'
  | 'map'
  | 'digest'
  | 'settings'
  | 'workspaces'
  | 'workspace-manage'
  | 'trash'
  | 'archived'
  | 'profile'
  | 'agents'
  | 'agent-manage';

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
  /** Live workspaces (excludes the active one + deleted/archived) offered as
   *  direct jump targets in the palette. */
  workspaces: Array<{ id: string; name: string }>;
  /** Jump straight to a workspace: switch the active project and route to the
   *  dashboard so its active tree renders. */
  switchWorkspace: (projectId: string) => void;
  createThread: () => void;
  activateTree: (treeId: string) => void;
  archiveTree: (treeId: string) => void;
  unarchiveTree: (treeId: string) => void;
  activeTreeId: string | null;
  liveTrees: Array<{ id: string; name: string }>;
  archivedTrees: Array<{ id: string; name: string }>;
  customAgentsEnabled: boolean;
}

export function buildCommands(ctx: CommandContext): Command[] {
  const out: Command[] = [];
  // Kept in ACTION rather than NAV so the long-standing fixed nav-command
  // ordering/shortcut contract remains unchanged; it still routes to a page.
  if (ctx.customAgentsEnabled) {
    out.push({ id: 'agents.open', group: 'action', icon: 'agent', label: 'Open Agent Library', run: () => ctx.setPage('agents') });
  }
  out.push({ id: 'nav.desk', group: 'nav', icon: 'desk', label: 'Open Desk', run: () => ctx.setPage('desk') });
  if (ctx.hasActiveProject) {
    out.push(
      { id: 'nav.home',       group: 'nav', icon: 'home', label: 'Go to home',            keys: kbd('mod', '0'), run: () => ctx.setPage('home') },
      { id: 'nav.branches',   group: 'nav', icon: 'branches', label: 'Open branch overview',  run: () => ctx.setPage('branches') },
      { id: 'nav.map',        group: 'nav', icon: 'map', label: 'Open map',              keys: kbd('mod', 'M'), run: () => ctx.setPage('map') },
      { id: 'nav.digest',     group: 'nav', icon: 'digest', label: 'Open thread digest',    keys: kbd('mod', 'D'), run: () => ctx.setPage('digest') },
      { id: 'nav.workspaces', group: 'nav', icon: 'workspace', label: 'Switch workspace…',     keys: kbd('mod', 'O'), run: () => ctx.setPage('workspaces') },
      { id: 'nav.trash',      group: 'nav', icon: 'trash', label: 'Open trash',            run: () => ctx.setPage('trash') },
      { id: 'nav.archived',   group: 'nav', icon: 'archive', label: 'Open archived nodes',    run: () => ctx.setPage('archived') },
      { id: 'nav.settings',   group: 'nav', icon: 'settings', label: 'Open settings',         keys: kbd('mod', ','), run: () => ctx.setPage('settings') },
    );
    if (PROFILE_PAGE_ENABLED) {
      out.push(
        { id: 'nav.profile', group: 'nav', icon: 'profile', label: 'Open profile', keys: kbd('mod', 'P'), run: () => ctx.setPage('profile') },
      );
    }
    out.push({ id: 'thread.new', group: 'action', icon: 'plus', label: 'New thread', keys: kbd('mod', 'T'), run: ctx.createThread });
    out.push({
      id: 'action.permissions',
      group: 'action',
      icon: 'shield',
      label: 'Permission settings',
      run: () => ctx.setPage('settings'),
    });
    for (const t of ctx.liveTrees) {
      out.push({ id: `thread.switch.${t.id}`, group: 'nav', icon: 'thread', label: `Switch to thread ▸ ${t.name}`, run: () => ctx.activateTree(t.id) });
    }
    for (const t of ctx.archivedTrees) {
      out.push({ id: `thread.switch.archived.${t.id}`, group: 'nav', icon: 'archive', label: `Switch to archived thread ▸ ${t.name}`, run: () => ctx.activateTree(t.id) });
    }
    if (ctx.activeTreeId) {
      out.push({ id: 'thread.archive', group: 'action', icon: 'archive', label: 'Archive current thread', run: () => ctx.archiveTree(ctx.activeTreeId!) });
    }
  }
  if (ctx.selection.size >= 2) {
    out.push(
      { id: 'action.weave',  group: 'action', icon: 'weave', label: `Weave ${ctx.selection.size} chats`,        run: ctx.fanoutFromSelection },
      { id: 'action.digest', group: 'action', icon: 'digest', label: `Digest from ${ctx.selection.size} chats`, keys: kbd('shift', 'mod', 'D'), run: ctx.digestFromSelection },
      { id: 'action.export', group: 'action', icon: 'export', label: `Export ${ctx.selection.size} selected`,                 run: ctx.exportSelection },
      { id: 'action.clear',  group: 'action', icon: 'close', label: 'Clear selection',                          keys: 'esc',  run: ctx.clearSelection },
    );
  }
  for (const w of ctx.workspaces) {
    out.push({
      id: `workspace.switch.${w.id}`,
      group: 'workspace',
      icon: 'workspace',
      label: `Switch to workspace ▸ ${w.name}`,
      run: () => ctx.switchWorkspace(w.id),
    });
  }
  const chatsToShow = ctx.allChats.slice(0, 50);
  for (const c of chatsToShow) {
    out.push({
      id: `chat.${c.id}`,
      group: 'chat',
      icon: 'chat',
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
