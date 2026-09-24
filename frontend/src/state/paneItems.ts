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

export interface SourceLocation {
  line: number;
  column?: number;
}

export interface FilePaneItem extends PaneItemBase {
  kind: 'file';
  filePath: string;
  viewMode: 'rendered' | 'source';
  diskState?: 'changed' | 'removed';
  /** Optional source location for scroll-to-line after load. Column is stored
   *  but horizontal positioning is not yet implemented. */
  sourceLocation?: SourceLocation;
  /** Raw link target checked before interpreting its numeric suffix as a source location. */
  sourceReferencePath?: string;
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

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

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
    if (
      typeof item.filePath !== 'string'
      || (item.viewMode !== 'rendered' && item.viewMode !== 'source')
      || (item.diskState !== undefined && item.diskState !== 'changed' && item.diskState !== 'removed')
    ) return false;
    if (item.sourceReferencePath !== undefined) {
      if (typeof item.sourceReferencePath !== 'string' || !item.sourceReferencePath || item.sourceLocation === undefined) return false;
    }
    if (item.sourceLocation !== undefined) {
      if (typeof item.sourceLocation !== 'object' || item.sourceLocation === null) return false;
      const loc = item.sourceLocation as Record<string, unknown>;
      if (!isPositiveSafeInteger(loc.line)) return false;
      if (loc.column !== undefined && !isPositiveSafeInteger(loc.column)) return false;
    }
    return true;
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

/**
 * Parse an optional trailing `:line` or `:line:column` source location from a
 * file path string. Returns the clean file path and any parsed location.
 *
 * Only strips the suffix when the trailing colon-separated segments are positive
 * integers. This is safe for Windows drive-letter paths like `C:\file.ts:42`
 * because a drive letter is not a positive integer.
 */
export function parseSourceLocation(raw: string): { filePath: string; line?: number; column?: number } {
  // Match 1-2 trailing `:number` segments. We reject cases where there are more
  // than 2 consecutive colon-digit groups to avoid ambiguity.
  const match = raw.match(/:(\d+)(?::(\d+))?$/);
  if (!match) return { filePath: raw };

  // Reject if there's a third colon-digit group before the match — ambiguous.
  const prefixEnd = match.index!;
  const filePath = raw.slice(0, prefixEnd);
  if (!filePath || /:\d+$/.test(filePath)) return { filePath: raw };

  const lineStr = match[1];
  const colStr = match[2];

  const line = Number(lineStr);
  if (!Number.isSafeInteger(line) || line < 1) return { filePath: raw };

  // Guard against stripping a Windows drive letter: if the file path before the
  // match is a single letter, this is `X:123` not `file:123`.
  if (filePath.length === 1 && /^[a-zA-Z]$/.test(filePath)) return { filePath: raw };

  if (colStr !== undefined) {
    const column = Number(colStr);
    if (!Number.isSafeInteger(column) || column < 1) return { filePath: raw };
    return { filePath, line, column };
  }

  return { filePath, line };
}
