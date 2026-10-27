import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { killProcessTree } from "../src/core/processTree";

describe("processTree", () => {
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
});
