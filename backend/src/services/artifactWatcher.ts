/**
 * ArtifactWatcher — idle-time filesystem watching for the ArtifactPane viewer.
 *
 * The ArtifactPane is a pure viewer: it reads a file's content into
 * `artifact.content` once at mount for rendering, with no editable buffer.
 * Disk is the single source of truth. When a watched file changes on disk —
 * from ANY source (agent Edit/Write, the user in an external editor, a
 * `git checkout`) — this module pushes a `changed` event so the frontend can
 * surface a "Changed on disk · refresh" badge. There is no dirty buffer to reconcile, so
 * re-reading is always safe; we deliberately do NOT try to attribute authorship.
 *
 * Design (mirrors chatManager's cwd-keyed pool):
 *   - One watcher entry per resolved cwd (realpath-keyed to dedupe symlinked cwds).
 *   - The watch set is *frontend-declared* via `declareArtifactWatchPaths` — the
 *     backend stays stateless about "which artifacts exist" (that registry lives
 *     on the frontend). Each declared path goes through `resolveWithinCwd` so a
 *     path escaping the workspace cwd is rejected (never watched).
 *   - We watch PARENT DIRECTORIES, not single files: native `fs.watch` on a
 *     single file breaks under atomic saves (write-temp + rename, which most
 *     editors do) and macOS FSEvents is directory-grained anyway. One
 *     `fs.watch(dir, { persistent: false })` per deduped parent dir; events are
 *     filtered by filename against the registered set.
 *   - For symlink artifacts (a cwd-relative link under `.artifacts/` pointing at
 *     an external file), `fs.realpathSync` yields the target; we watch the
 *     TARGET's dir (edits land there) but emit the stored (link) path so the
 *     frontend can string-match against `n.artifact.filePath`.
 *   - Debounce (~250ms per path) then `fs.stat` and compare mtime/size to the
 *     last-known values — emit only on a REAL change. This swallows no-op touches
 *     and our own read echoes without any author-based suppression.
 *   - Lifecycle is refcounted by SSE subscribers: first subscriber on a cwd
 *     builds the OS watchers, last disconnect tears them down.
 *   - `fs.stat` throwing ENOENT ⇒ emit `{ removed: true }`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveWithinCwd, PathSandboxError } from "../agents/tools/pathSandbox";

/** Push payload delivered to each subscriber. `filePath` is the STORED form. */
export type ArtifactWatchEvent =
  | { filePath: string; removed: false; mtimeMs: number; size: number }
  | { filePath: string; removed: true };

type Subscriber = (evt: ArtifactWatchEvent) => void;

/** One registered path within a watcher entry. */
interface Registration {
  /** Exactly what the pane stores in `n.artifact.filePath` (relative or absolute). */
  storagePath: string;
  /** Absolute, sandbox-resolved path (following the link for symlink artifacts). */
  realPath: string;
  /** Directory we attach `fs.watch` to — the real file's parent. */
  dir: string;
  /** Basename used to filter directory events. */
  base: string;
  /** Last-known state, seeded at declare time so only future changes emit. */
  mtimeMs: number | null;
  size: number | null;
}

interface WatcherEntry {
  /** Resolved workspace cwd (as passed by the caller). */
  cwd: string;
  regs: Map<string, Registration>; // keyed by storagePath
  dirWatchers: Map<string, fs.FSWatcher>; // keyed by dir
  debounce: Map<string, ReturnType<typeof setTimeout>>; // keyed by storagePath
  subscribers: Set<Subscriber>;
}

/** cwd (realpath-keyed) → entry. */
const pool = new Map<string, WatcherEntry>();

/** Debounce window; read per-schedule so tests can lower it via env. */
function debounceMs(): number {
  const raw = Number(process.env.ARTIFACT_WATCH_DEBOUNCE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 250;
}

/** Guard rail: cap declared paths per workspace so a bad client can't flood us. */
const MAX_WATCH_PATHS = 500;

/** Realpath-key a cwd so two symlinked cwd strings share one watcher. */
function poolKey(cwd: string): string {
  try {
    return fs.realpathSync(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

function getOrCreateEntry(cwd: string): WatcherEntry {
  const key = poolKey(cwd);
  let entry = pool.get(key);
  if (!entry) {
    entry = {
      cwd,
      regs: new Map(),
      dirWatchers: new Map(),
      debounce: new Map(),
      subscribers: new Set(),
    };
    pool.set(key, entry);
  }
  return entry;
}

/**
 * Stat the real file and, if mtime/size differ from last-known, update the
 * registration and emit `changed`. ENOENT ⇒ emit `removed` (once). No-op if
 * the registration was dropped while the debounce timer was pending.
 */
function confirmAndEmit(entry: WatcherEntry, storagePath: string): void {
  const reg = entry.regs.get(storagePath);
  if (!reg) return;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(reg.realPath);
  } catch {
    // ENOENT (or any stat failure) → treat as removed. Only emit once: clear
    // last-known so a subsequent identical failure stays quiet.
    if (reg.mtimeMs !== null || reg.size !== null) {
      reg.mtimeMs = null;
      reg.size = null;
      emit(entry, { filePath: storagePath, removed: true });
    }
    return;
  }

  if (!stat.isFile()) return;

  if (stat.mtimeMs === reg.mtimeMs && stat.size === reg.size) {
    // Stat-identical → a no-op touch or our own read echo. Swallow.
    return;
  }
  reg.mtimeMs = stat.mtimeMs;
  reg.size = stat.size;
  emit(entry, {
    filePath: storagePath,
    removed: false,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  });
}

function emit(entry: WatcherEntry, evt: ArtifactWatchEvent): void {
  for (const sub of entry.subscribers) {
    try {
      sub(evt);
    } catch {
      // A dead subscriber shouldn't take down the fan-out; res.on('close')
      // detaches it shortly.
    }
  }
}

function scheduleConfirm(entry: WatcherEntry, storagePath: string): void {
  const existing = entry.debounce.get(storagePath);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    entry.debounce.delete(storagePath);
    confirmAndEmit(entry, storagePath);
  }, debounceMs());
  // Don't keep the process alive on a pending debounce.
  timer.unref?.();
  entry.debounce.set(storagePath, timer);
}

/** Handle one raw fs.watch event for `dir`. */
function onDirEvent(entry: WatcherEntry, dir: string, filename: string | null): void {
  for (const reg of entry.regs.values()) {
    if (reg.dir !== dir) continue;
    // `filename` is null on some platforms/events → re-check every reg in the dir.
    if (filename !== null && filename !== reg.base) continue;
    scheduleConfirm(entry, reg.storagePath);
  }
}

/**
 * Reconcile OS watchers to match the registered dir set. Only holds handles
 * while there is at least one subscriber; a declared-but-unsubscribed entry
 * keeps its regs but no fs.watch handles.
 */
function ensureWatchers(entry: WatcherEntry): void {
  if (entry.subscribers.size === 0) {
    for (const w of entry.dirWatchers.values()) w.close();
    entry.dirWatchers.clear();
    return;
  }

  const neededDirs = new Set<string>();
  for (const reg of entry.regs.values()) neededDirs.add(reg.dir);

  // Drop watchers for dirs no longer needed.
  for (const [dir, w] of entry.dirWatchers) {
    if (!neededDirs.has(dir)) {
      w.close();
      entry.dirWatchers.delete(dir);
    }
  }

  // Add watchers for newly-needed dirs.
  for (const dir of neededDirs) {
    if (entry.dirWatchers.has(dir)) continue;
    try {
      const w = fs.watch(dir, { persistent: false }, (_eventType, filename) => {
        onDirEvent(entry, dir, filename == null ? null : filename.toString());
      });
      w.on("error", () => {
        // Directory vanished or watch failed — drop this watcher; a re-declare
        // will re-establish it once the dir exists again.
        try {
          w.close();
        } catch {
          /* already closed */
        }
        entry.dirWatchers.delete(dir);
      });
      entry.dirWatchers.set(dir, w);
    } catch {
      // Parent dir doesn't exist yet (e.g. .contexts not created) — skip; a
      // later declare re-tries. Nothing to watch means nothing to emit.
    }
  }
}

/**
 * Establish/replace the cwd's watch set. Each path is sandbox-resolved against
 * `cwd`; escaping paths are rejected (not watched). Returns the accepted stored
 * paths. Idempotent replace: re-declaring the same path preserves its
 * last-known state so a change mid-declare isn't lost.
 */
export function declareArtifactWatchPaths(
  cwd: string,
  storagePaths: string[],
): { watching: string[]; rejected: string[] } {
  const entry = getOrCreateEntry(cwd);
  const watching: string[] = [];
  const rejected: string[] = [];
  const nextRegs = new Map<string, Registration>();

  const capped = storagePaths.slice(0, MAX_WATCH_PATHS);
  for (const storagePath of capped) {
    if (typeof storagePath !== "string" || storagePath.trim() === "") {
      rejected.push(String(storagePath));
      continue;
    }
    if (nextRegs.has(storagePath)) continue; // dedupe

    let abs: string;
    try {
      abs = resolveWithinCwd(storagePath, cwd);
    } catch (err) {
      if (err instanceof PathSandboxError) {
        rejected.push(storagePath);
        continue;
      }
      rejected.push(storagePath);
      continue;
    }

    // Follow symlinks to the real target so we watch where edits actually land.
    // If the file doesn't exist yet, fall back to the resolved abs path (its
    // parent dir still exists for .contexts/.artifacts files).
    let realPath: string;
    try {
      realPath = fs.realpathSync(abs);
    } catch {
      realPath = abs;
    }

    const prev = entry.regs.get(storagePath);
    let reg: Registration;
    if (prev && prev.realPath === realPath) {
      // Carry over last-known so a change between declares isn't swallowed.
      reg = prev;
    } else {
      let mtimeMs: number | null = null;
      let size: number | null = null;
      try {
        const st = fs.statSync(realPath);
        if (st.isFile()) {
          mtimeMs = st.mtimeMs;
          size = st.size;
        }
      } catch {
        // Not on disk yet — seed as absent; creation shows up as a change.
      }
      reg = {
        storagePath,
        realPath,
        dir: path.dirname(realPath),
        base: path.basename(realPath),
        mtimeMs,
        size,
      };
    }
    nextRegs.set(storagePath, reg);
    watching.push(storagePath);
  }

  // Clear debounce timers for paths that are no longer registered.
  for (const oldPath of entry.regs.keys()) {
    if (!nextRegs.has(oldPath)) {
      const t = entry.debounce.get(oldPath);
      if (t) {
        clearTimeout(t);
        entry.debounce.delete(oldPath);
      }
    }
  }

  entry.regs = nextRegs;
  ensureWatchers(entry);
  maybeDropEntry(entry);
  return { watching, rejected };
}

/**
 * Subscribe an SSE client to a cwd's change events. Returns an unsubscribe fn
 * to call from `res.on('close')`. First subscriber builds the OS watchers (if
 * paths are already declared); last unsubscribe tears the entry down.
 */
export function subscribeArtifactWatch(cwd: string, onEvent: Subscriber): () => void {
  const entry = getOrCreateEntry(cwd);
  entry.subscribers.add(onEvent);
  ensureWatchers(entry);

  let done = false;
  return () => {
    if (done) return;
    done = true;
    entry.subscribers.delete(onEvent);
    ensureWatchers(entry); // closes OS handles when subscribers hit 0
    maybeDropEntry(entry);
  };
}

/**
 * Drop an entry once its last SSE subscriber leaves ("last disconnect →
 * close"). Declared paths do NOT keep it alive: the frontend re-declares its
 * path set on every EventSource `open` (including auto-reconnects), so a
 * reconnect rebuilds the entry from scratch. This keeps the pool bounded by
 * live connections, not by history.
 */
function maybeDropEntry(entry: WatcherEntry): void {
  if (entry.subscribers.size > 0) return;
  for (const t of entry.debounce.values()) clearTimeout(t);
  entry.debounce.clear();
  for (const w of entry.dirWatchers.values()) w.close();
  entry.dirWatchers.clear();
  const key = poolKey(entry.cwd);
  if (pool.get(key) === entry) pool.delete(key);
}

/** Close every watcher and clear the pool. Wired into graceful shutdown. */
export function closeAllArtifactWatchers(): void {
  for (const entry of pool.values()) {
    for (const t of entry.debounce.values()) clearTimeout(t);
    entry.debounce.clear();
    for (const w of entry.dirWatchers.values()) {
      try {
        w.close();
      } catch {
        /* already closed */
      }
    }
    entry.dirWatchers.clear();
    entry.subscribers.clear();
    entry.regs.clear();
  }
  pool.clear();
}

/** Test-only: number of live watcher entries in the pool. */
export function _activeWatcherCount(): number {
  return pool.size;
}
