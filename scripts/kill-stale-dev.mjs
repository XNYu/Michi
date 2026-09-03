#!/usr/bin/env node
// Kill any prior `npm run dev` / `npm run electron:dev` instances of THIS repo
// before starting a fresh one. Prevents the multi-backend split-brain where
// two Electron windows share ~/.michi/data.db but each has its own
// localStorage / in-memory project list.
//
// Matches by command line containing the repo's absolute path, so other
// projects' Vite / nodemon / Electron processes are not touched.

import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKTREES_DIR = path.join(REPO_ROOT, '.worktrees') + path.sep;
const IS_WIN = process.platform === 'win32';

function parsePosixProcessTable(raw, withCommand) {
  const rows = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (withCommand) {
      const m = trimmed.match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      rows.push({ pid: Number(m[1]), cmd: m[2] });
    } else {
      const m = trimmed.match(/^(\d+)\s+(\d+)$/);
      if (!m) continue;
      rows.push({ pid: Number(m[1]), ppid: Number(m[2]) });
    }
  }
  return rows;
}

function listWindowsProcesses() {
  const script = [
    'Get-CimInstance Win32_Process | ForEach-Object {',
    '  $cmd = if ($_.CommandLine) { $_.CommandLine -replace "[\\r\\n\\t]", " " } else { "" }',
    '  "{0}`t{1}`t{2}" -f $_.ProcessId, $_.ParentProcessId, $cmd',
    '}',
  ].join(' ');
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [pidRaw, ppidRaw, ...rest] = line.split('\t');
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    if (!Number.isInteger(pid)) continue;
    rows.push({ pid, ppid, cmd: rest.join('\t') });
  }
  return rows;
}

function collectAncestors() {
  const ancestors = new Set([process.pid]);
  if (IS_WIN) {
    let rows;
    try {
      rows = listWindowsProcesses();
    } catch {
      ancestors.add(process.ppid);
      return ancestors;
    }
    const ppidByPid = new Map(rows.map((row) => [row.pid, row.ppid]));
    let cur = process.pid;
    while (true) {
      const parent = ppidByPid.get(cur);
      if (!parent || parent <= 0 || ancestors.has(parent)) break;
      ancestors.add(parent);
      cur = parent;
    }
    return ancestors;
  }

  let raw;
  try {
    raw = execSync('ps -eo pid=,ppid=', { encoding: 'utf8' });
  } catch {
    ancestors.add(process.ppid);
    return ancestors;
  }
  const ppidByPid = new Map();
  for (const row of parsePosixProcessTable(raw, false)) {
    ppidByPid.set(row.pid, row.ppid);
  }
  let cur = process.pid;
  while (true) {
    const parent = ppidByPid.get(cur);
    if (!parent || parent <= 1 || ancestors.has(parent)) break;
    ancestors.add(parent);
    cur = parent;
  }
  return ancestors;
}

const ANCESTOR_PIDS = collectAncestors();

function belongsToThisCheckout(cmd) {
  if (!cmd.includes(REPO_ROOT)) return false;
  if (cmd.includes(WORKTREES_DIR)) return false;
  return true;
}

function looksLikeDev(cmd) {
  return (
    /electron(\.exe)?\b/i.test(cmd) ||
    /node .*[\\/](nodemon|tsx|vite|concurrently)\b/.test(cmd) ||
    /electron[\\/]dist[\\/]main\.js/.test(cmd) ||
    /backend[\\/]dist[\\/]server\.js/.test(cmd) ||
    /\bnpm(\.cmd)? (run|exec) (dev|electron:dev)/.test(cmd) ||
    /Michi\.app|michi\.app|michi\.exe/i.test(cmd)
  );
}

function listMatchingPids() {
  let rows;
  try {
    if (IS_WIN) {
      rows = listWindowsProcesses();
    } else {
      const raw = execSync('ps -eo pid=,command=', { encoding: 'utf8' });
      rows = parsePosixProcessTable(raw, true);
    }
  } catch {
    return [];
  }
  const matches = [];
  for (const row of rows) {
    if (ANCESTOR_PIDS.has(row.pid)) continue;
    if (!belongsToThisCheckout(row.cmd)) continue;
    if (!looksLikeDev(row.cmd)) continue;
    matches.push({ pid: row.pid, cmd: row.cmd });
  }
  return matches;
}

const DRY_RUN = process.env.MICHI_KILL_DRY_RUN === '1';

const targets = listMatchingPids();
if (targets.length === 0) {
  process.exit(0);
}

const verb = DRY_RUN ? 'would kill' : 'killing';
console.log(`[kill-stale-dev] ${verb} ${targets.length} stale dev process(es) tied to this repo:`);
for (const { pid, cmd } of targets) {
  const short = cmd.length > 110 ? cmd.slice(0, 110) + '…' : cmd;
  console.log(`  pid=${pid}  ${short}`);
  if (DRY_RUN) continue;
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
}

if (DRY_RUN) process.exit(0);

const deadline = Date.now() + 1500;
function stillAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
(function waitLoop() {
  const remaining = targets.filter((t) => stillAlive(t.pid));
  if (remaining.length === 0) return;
  if (Date.now() >= deadline) {
    for (const { pid } of remaining) {
      console.log(`[kill-stale-dev] SIGKILL pid=${pid}`);
      try {
        if (IS_WIN) {
          execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
        } else {
          process.kill(pid, 'SIGKILL');
        }
      } catch { /* */ }
    }
    return;
  }
  const until = Date.now() + 100;
  while (Date.now() < until) { /* tight wait */ }
  waitLoop();
})();
