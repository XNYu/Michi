import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveBashShell } from "../src/agents/tools/bash";

describe("resolveBashShell", () => {
  test("POSIX always uses bash -c", () => {
    assert.deepEqual(resolveBashShell("darwin", () => "/opt/bash"), {
      command: "bash",
      prefix: ["-c"],
    });
  });

  test("Windows prefers a PATH bash when present", () => {
    assert.deepEqual(resolveBashShell("win32", (name) => (name === "bash" ? "C:\\Git\\bin\\bash.exe" : null)), {
      command: "C:\\Git\\bin\\bash.exe",
      prefix: ["-c"],
    });
  });

  test("Windows falls back to cmd.exe", () => {
    const previous = process.env.ComSpec;
    process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
    try {
      assert.deepEqual(resolveBashShell("win32", () => null), {
        command: "C:\\Windows\\System32\\cmd.exe",
        prefix: ["/d", "/s", "/c"],
      });
    } finally {
      if (previous === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = previous;
    }
  });
});
