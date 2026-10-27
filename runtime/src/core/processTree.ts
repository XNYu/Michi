/**
 * Cross-platform child-process helpers for agent CLIs.
 *
 * POSIX: `detached: true` + `kill(-pid)` owns a process group.
 * Windows: negative PIDs are invalid, and `detached: true` opens a new
 * console window — use `taskkill /T` and keep the child attached + hidden.
 */

import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from "node:child_process";

export interface ProcessTreeDeps {
  platform?: NodeJS.Platform;
  execFileSync?: typeof execFileSync;
  kill?: (pid: number, signal?: NodeJS.Signals | number) => true;
}

export function agentSpawnOptions(
  overrides: SpawnOptions = {},
  platform: NodeJS.Platform = process.platform,
): SpawnOptions {
  return {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: platform !== "win32",
    ...overrides,
  };
}

export function spawnAgentProcess(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcessWithoutNullStreams {
  const opts = agentSpawnOptions(options);
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const comspec = process.env.ComSpec || "cmd.exe";
    return spawn(comspec, ["/d", "/s", "/c", command, ...args], opts) as ChildProcessWithoutNullStreams;
  }
  return spawn(command, args, opts) as ChildProcessWithoutNullStreams;
}

function isKillSignal(signal: NodeJS.Signals | number): boolean {
  return signal === "SIGKILL" || signal === 9;
}

/**
 * Best-effort teardown of `pid` and every descendant.
 * SIGTERM → Windows `taskkill /T`; SIGKILL → `taskkill /F /T`.
 * POSIX keeps the historical `kill(-pid)` process-group signal.
 */
export function killProcessTree(
  pid: number,
  signal: NodeJS.Signals | number = "SIGTERM",
  deps: ProcessTreeDeps = {},
): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const platform = deps.platform ?? process.platform;
  const run = deps.execFileSync ?? execFileSync;
  const kill = deps.kill ?? ((target, sig) => process.kill(target, sig));

  if (platform === "win32") {
    const args = isKillSignal(signal)
      ? ["/F", "/T", "/PID", String(pid)]
      : ["/T", "/PID", String(pid)];
    try {
      run("taskkill", args, { stdio: "ignore", windowsHide: true });
      return;
    } catch {
      try {
        kill(pid, isKillSignal(signal) ? "SIGKILL" : "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    return;
  }

  try {
    kill(-pid, signal);
  } catch {
    try {
      kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}
