#!/usr/bin/env node
// Kill any prior `npm run dev` / `npm run electron:dev` instances of THIS repo
// before starting a fresh one. Prevents the multi-backend split-brain where
// two Electron windows share ~/.michi/data.db but each has its own
// localStorage / in-memory project list.
//
// Matches by command line containing the repo's absolute path, so other
// projects' Vite / nodemon / Electron processes are not touched.

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKTREES_DIR = path.join(REPO_ROOT, '.worktrees') + path.sep;

// Walk up the process tree from ourselves and collect every ancestor pid.
// We must never SIGTERM the npm / shell that just invoked us; killing the
// shell would also tear down whatever sibling task (e.g. an LLM session)
// happens to share that terminal.
function collectAncestors() {
  const ancestors = new Set([process.pid]);
  let raw;
  try {
    raw = execSync('ps -eo pid=,ppid=', { encoding: 'utf8' });
  } catch {
    ancestors.add(process.ppid);
    return ancestors;
  }
  const ppidByPid = new Map();
  for (const line of raw.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    ppidByPid.set(Number(m[1]), Number(m[2]));
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
  // Must reference this checkout's path …
  if (!cmd.includes(REPO_ROOT)) return false;
  // … but not a sibling git worktree under .worktrees/, which is its own
  // independent dev environment we must never touch.
  if (cmd.includes(WORKTREES_DIR)) return false;
  return true;
}

function listMatchingPids() {
  // ps -eo pid,command — fields separated by whitespace; command can contain spaces.
  let raw;
  try {
    raw = execSync('ps -eo pid=,command=', { encoding: 'utf8' });
  } catch {
    return [];
  }
  const matches = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[2];
    if (ANCESTOR_PIDS.has(pid)) continue;
    if (!belongsToThisCheckout(cmd)) continue;
    // Filter to dev-server / electron-launch shaped commands; ignore
    // shells / editors / git that just happen to have the path in argv.
    const looksLikeDev =
      / electron\b/.test(cmd) ||
      /node .*\/(nodemon|tsx|vite|concurrently)\b/.test(cmd) ||
      /electron\/dist\/main\.js/.test(cmd) ||
      /backend\/dist\/server\.js/.test(cmd) ||
      /\bnpm (run|exec) (dev|electron:dev)/.test(cmd) ||
      /Michi\.app|michi\.app/.test(cmd);
    if (!looksLikeDev) continue;
    matches.push({ pid, cmd });
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

// Give them a moment to exit cleanly, then SIGKILL anything still alive.
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
      try { process.kill(pid, 'SIGKILL'); } catch { /* */ }
    }
    return;
  }
  // Busy-wait briefly; this script runs to completion before npm continues,
  // so blocking is fine and avoids leaking timers.
  const until = Date.now() + 100;
  while (Date.now() < until) { /* tight wait */ }
  waitLoop();
})();
