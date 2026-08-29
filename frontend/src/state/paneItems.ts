export type PaneItemKind = 'launcher' | 'files' | 'review' | 'file' | 'diff' | 'terminal' | 'browser' | 'agent-run';
export type PaneLauncherChoice = 'review' | 'terminal' | 'browser' | 'files' | 'side-chat';

interface PaneItemBase {
  id: string;
  kind: PaneItemKind;
  projectId: string;
  treeId: string | null;
  title: string;
  createdAt: number;
  width?: number;
}

export interface LauncherPaneItem extends PaneItemBase {
  kind: 'launcher';
  /** Chat pane that was focused when the launcher opened. Used by Side chat. */
  anchorNodeId?: string;
}

export interface FilesPaneItem extends PaneItemBase {
  kind: 'files';
}

export interface ReviewPaneItem extends PaneItemBase {
  kind: 'review';
}

export interface FilePaneItem extends PaneItemBase {
  kind: 'file';
  filePath: string;
  viewMode: 'rendered' | 'source';
  diskState?: 'changed' | 'removed';
}

export interface DiffPaneItem extends PaneItemBase {
  kind: 'diff';
  filePath: string;
}

export interface TerminalPaneItem extends PaneItemBase {
  kind: 'terminal';
  surfaceId: string;
  cwd: string;
}

export interface BrowserPaneItem extends PaneItemBase {
  kind: 'browser';
  surfaceId: string;
  url: string;
}

export interface AgentRunPaneItem extends PaneItemBase {
  kind: 'agent-run';
  backendConnectionId: string;
  runId: string;
}

export type PaneItem =
  | LauncherPaneItem
  | FilesPaneItem
  | ReviewPaneItem
  | FilePaneItem
  | DiffPaneItem
  | TerminalPaneItem
  | BrowserPaneItem
  | AgentRunPaneItem;

const KINDS = new Set<PaneItemKind>(['launcher', 'files', 'review', 'file', 'diff', 'terminal', 'browser', 'agent-run']);

export function isPaneItem(value: unknown): value is PaneItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== 'string' ||
    !KINDS.has(item.kind as PaneItemKind) ||
    typeof item.projectId !== 'string' ||
    !(typeof item.treeId === 'string' || item.treeId === null) ||
    typeof item.title !== 'string' ||
    typeof item.createdAt !== 'number'
  ) return false;
  if (item.width !== undefined && (typeof item.width !== 'number' || !Number.isFinite(item.width))) return false;
  if (item.kind === 'launcher') return item.anchorNodeId === undefined || typeof item.anchorNodeId === 'string';
  if (item.kind === 'files' || item.kind === 'review') return true;
  if (item.kind === 'file') {
    return typeof item.filePath === 'string'
      && (item.viewMode === 'rendered' || item.viewMode === 'source')
      && (item.diskState === undefined || item.diskState === 'changed' || item.diskState === 'removed');
  }
  if (item.kind === 'diff') return typeof item.filePath === 'string';
  if (item.kind === 'terminal') return typeof item.surfaceId === 'string' && typeof item.cwd === 'string';
  if (item.kind === 'browser') return typeof item.surfaceId === 'string' && typeof item.url === 'string';
  return typeof item.backendConnectionId === 'string' && typeof item.runId === 'string';
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function singletonPaneId(kind: 'file' | 'diff', projectId: string, filePath: string): string {
  return `pane:${kind}:${fnv1a(`${projectId}\0${filePath}`)}`;
}

/** Stable per-window pane identity for a durable Run on a specific Backend. */
export function agentRunPaneId(backendConnectionId: string, runId: string): string {
  return `pane:agent-run:${encodeURIComponent(backendConnectionId)}:${encodeURIComponent(runId)}`;
}

export function uniquePaneId(kind: 'launcher' | 'terminal' | 'browser'): string {
  const token = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `pane:${kind}:${token}`;
}

export function paneItemTitle(item: PaneItem): string {
  if (item.title.trim()) return item.title;
  if (item.kind === 'file' || item.kind === 'diff') {
    return item.filePath.split('/').filter(Boolean).pop() ?? item.filePath;
  }
  if (item.kind === 'launcher') return 'New pane';
  if (item.kind === 'files') return 'Files';
  if (item.kind === 'review') return 'Review';
  if (item.kind === 'agent-run') return 'Agent Run';
  return item.kind === 'terminal' ? 'Terminal' : 'Browser';
}

export function normalizeBrowserUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withProtocol = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
