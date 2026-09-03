import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { agentSpawnOptions, killProcessTree } from "../src/agents/processTree";

describe("processTree", () => {
  test("agentSpawnOptions detaches only off Windows", () => {
    assert.equal(agentSpawnOptions({}, "win32").detached, false);
    assert.equal(agentSpawnOptions({}, "darwin").detached, true);
    assert.equal(agentSpawnOptions({}, "win32").windowsHide, true);
  });

  test("agentSpawnOptions lets callers override detached", () => {
    assert.equal(agentSpawnOptions({ detached: true }, "win32").detached, true);
  });

  test("killProcessTree is a no-op for invalid pids", () => {
    const killed: Array<[number, NodeJS.Signals | number | undefined]> = [];
    killProcessTree(0, "SIGTERM", { kill: (pid, signal) => { killed.push([pid, signal]); return true; } });
    killProcessTree(-3, "SIGTERM", { kill: (pid, signal) => { killed.push([pid, signal]); return true; } });
    assert.deepEqual(killed, []);
  });

  test("Windows SIGTERM uses taskkill /T /PID", () => {
    const calls: Array<[string, readonly string[]]> = [];
    killProcessTree(4242, "SIGTERM", {
      platform: "win32",
      execFileSync: ((cmd: string, args: readonly string[]) => {
        calls.push([cmd, args]);
        return Buffer.alloc(0);
      }) as typeof import("node:child_process").execFileSync,
    });
    assert.deepEqual(calls, [["taskkill", ["/T", "/PID", "4242"]]]);
  });

  test("Windows SIGKILL uses taskkill /F /T /PID", () => {
    const calls: Array<[string, readonly string[]]> = [];
    killProcessTree(7, "SIGKILL", {
      platform: "win32",
      execFileSync: ((cmd: string, args: readonly string[]) => {
        calls.push([cmd, args]);
        return Buffer.alloc(0);
      }) as typeof import("node:child_process").execFileSync,
    });
    assert.deepEqual(calls, [["taskkill", ["/F", "/T", "/PID", "7"]]]);
  });

  test("Windows falls back to process.kill when taskkill fails", () => {
    const killed: Array<[number, NodeJS.Signals | number | undefined]> = [];
    killProcessTree(5, "SIGKILL", {
      platform: "win32",
      execFileSync: () => {
        throw new Error("taskkill missing");
      },
      kill: (pid, signal) => {
        killed.push([pid, signal]);
        return true;
      },
    });
    assert.deepEqual(killed, [[5, "SIGKILL"]]);
  });

  test("POSIX signals the process group, then the pid", () => {
    const killed: Array<[number, NodeJS.Signals | number | undefined]> = [];
    killProcessTree(99, "SIGTERM", {
      platform: "darwin",
      kill: (pid, signal) => {
        killed.push([pid, signal]);
        return true;
      },
    });
    assert.deepEqual(killed, [[-99, "SIGTERM"]]);
  });

  test("POSIX falls back to the raw pid when group kill fails", () => {
    const killed: Array<[number, NodeJS.Signals | number | undefined]> = [];
    killProcessTree(12, "SIGKILL", {
      platform: "linux",
      kill: (pid, signal) => {
        if (pid < 0) throw new Error("no group");
        killed.push([pid, signal]);
        return true;
      },
    });
    assert.deepEqual(killed, [[12, "SIGKILL"]]);
  });
});
