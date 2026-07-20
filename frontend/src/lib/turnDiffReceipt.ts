import type { ChatMessage, ToolCallState } from '../state/chatTypes';

/**
 * Turn diff receipts — derive a compact "N files changed (+X −Y)" summary
 * from the file-mutating tool calls already present on an assistant message.
 *
 * Pure frontend derivation: no new SSE event. Every write/edit tool call is
 * persisted on the message with its (truncated) inputJson, so at turn-end we
 * can reconstruct which files were touched and estimate line deltas.
 *
 * Heuristics (v1):
 *   - `write`: added = line count of `content`, removed = 0. A write is a
 *     full overwrite so a later write to the same path REPLACES any counts
 *     accumulated so far for that path.
 *   - `edit`: added = line count of `new_string`, removed = line count of
 *     `old_string`. Edits ACCUMULATE per path.
 *   - Codex `fileChange` items: title is 'Edit <basename>' / 'Edit N files'
 *     and inputJson is the whole item with a `changes: [{ path, ... }]`
 *     array (no path/file_path key). We list the touched paths; Codex does
 *     not carry old/new strings, so line deltas stay 0 (the click-through
 *     diff modal shows the real delta).
 *   - `bash`: skipped — we can't know what a shell command did to files.
 *   - failed/errored tool calls are skipped (they didn't mutate anything).
 *   - `interrupted` tool calls (turn cancelled/errored while the tool was
 *     still active — see finalizeMessage in shared/turnProjection.ts) are
 *     skipped: the tool may never have executed.
 *   - unparseable/truncated inputJson is skipped.
 */

export interface DiffFileEntry {
  path: string;
  added: number;
  removed: number;
  kind: 'write' | 'edit' | 'bash';
}

export interface DiffReceipt {
  files: DiffFileEntry[];
  totalAdded: number;
  totalRemoved: number;
}

const SKIPPED_STATUSES = new Set(['error', 'failed', 'interrupted']);

/** Count lines in a string the way diff tools do: 1 line minimum, +1 per \n. */
function countLines(text: string): number {
  if (text === '') return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') n++;
  }
  // A trailing newline doesn't start a new line of content.
  if (text.endsWith('\n')) n--;
  return n;
}

/** Normalize a tool title to its mutation kind, or null if not file-mutating. */
function mutationKind(title: string): 'write' | 'edit' | null {
  const t = title.trim().toLowerCase();
  if (t === 'write' || t.startsWith('write ') || t.startsWith('writing ')) return 'write';
  if (t === 'edit' || t.startsWith('edit ') || t.startsWith('editing ')) return 'edit';
  return null;
}

/** Codex fileChange items carry a `changes: [{ path, ... }]` array. */
function extractCodexChangePaths(input: Record<string, unknown>): string[] {
  const changes = input.changes;
  if (!Array.isArray(changes)) return [];
  const paths: string[] = [];
  for (const change of changes) {
    if (change && typeof change === 'object' && !Array.isArray(change)) {
      const p = (change as Record<string, unknown>).path;
      if (typeof p === 'string' && p.trim() !== '') paths.push(p);
    }
  }
  return paths;
}

function extractPath(input: Record<string, unknown>): string | null {
  const p = input.path ?? input.file_path;
  return typeof p === 'string' && p.trim() !== '' ? p : null;
}

/**
 * Extract path from the `detail` field when inputJson is absent.
 * Claude runtime sets detail to "Write: /path/to/file" or "Edit: /path/to/file".
 */
function extractPathFromDetail(tool: ToolCallState): string | null {
  const d = tool.detail;
  if (!d) return null;
  const match = /^(?:Write|Edit|write|edit):\s*(.+)$/i.exec(d);
  return match ? match[1].trim() : null;
}

/**
 * Extract file path from a descriptive title like "Editing Topbar.tsx" or
 * "Writing quicksort.py". Only used as last resort when inputJson and detail
 * both lack a path.
 */
function extractPathFromTitle(tool: ToolCallState): string | null {
  const t = (tool.title ?? '').trim();
  const match = /^(?:Editing|Writing)\s+(.+)$/i.exec(t);
  return match ? match[1].trim() : null;
}

function parseInput(tool: ToolCallState): Record<string, unknown> | null {
  if (!tool.inputJson) return null;
  try {
    const parsed = JSON.parse(tool.inputJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Truncated (16KB cap) or malformed — skip this tool call.
  }
  return null;
}

/**
 * Derive a diff receipt from an assistant message's tool calls.
 * Returns null when the turn contained no successful file mutations.
 */
export function deriveDiffReceipt(message: ChatMessage): DiffReceipt | null {
  const byPath = new Map<string, DiffFileEntry>();

  for (const tool of message.toolCalls ?? []) {
    if (SKIPPED_STATUSES.has((tool.status ?? '').toLowerCase())) continue;
    const kind = mutationKind(tool.title ?? '');
    if (!kind) continue;
    const input = parseInput(tool);

    // Resolve path from multiple sources (inputJson > detail > title).
    const path = (input ? extractPath(input) : null)
      ?? extractPathFromDetail(tool)
      ?? extractPathFromTitle(tool);

    if (!path && input) {
      // Codex fileChange shape: no path/file_path, but a `changes` array.
      for (const changePath of extractCodexChangePaths(input)) {
        const prev = byPath.get(changePath);
        if (!prev) {
          byPath.set(changePath, { path: changePath, added: 0, removed: 0, kind: 'edit' });
        }
      }
      continue;
    }
    if (!path) continue;

    if (kind === 'write') {
      const content = input && typeof input.content === 'string' ? input.content : '';
      // Latest write wins: a write is a full overwrite of the file, so it
      // supersedes any counts accumulated for this path so far.
      byPath.set(path, { path, added: countLines(content), removed: 0, kind: 'write' });
    } else {
      const oldStr = input && typeof input.old_string === 'string' ? input.old_string : '';
      const newStr = input && typeof input.new_string === 'string' ? input.new_string : '';
      const prev = byPath.get(path);
      if (prev) {
        byPath.set(path, {
          path,
          added: prev.added + countLines(newStr),
          removed: prev.removed + countLines(oldStr),
          kind: prev.kind === 'write' ? 'write' : 'edit',
        });
      } else {
        byPath.set(path, { path, added: countLines(newStr), removed: countLines(oldStr), kind: 'edit' });
      }
    }
  }

  if (byPath.size === 0) return null;

  const files = [...byPath.values()];
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const f of files) {
    totalAdded += f.added;
    totalRemoved += f.removed;
  }
  return { files, totalAdded, totalRemoved };
}
