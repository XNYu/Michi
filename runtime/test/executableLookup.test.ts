import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { candidateNames, exeName, findOnPath, resolveNamedBinary, standardInstallDirs } from "../src/core/executableLookup";

describe("executableLookup", () => {
  test("candidateNames adds Windows suffixes and leaves POSIX names alone", () => {
    assert.deepEqual(candidateNames("claude", "win32"), ["claude.exe", "claude.cmd", "claude.bat", "claude"]);
    assert.deepEqual(candidateNames("claude.exe", "win32"), ["claude.exe"]);
    assert.deepEqual(candidateNames("claude", "darwin"), ["claude"]);
  });

  test("exeName appends .exe only on Windows when no suffix is present", () => {
    assert.equal(exeName("kiro-cli", "win32"), "kiro-cli.exe");
    assert.equal(exeName("kiro-cli.exe", "win32"), "kiro-cli.exe");
    assert.equal(exeName("kiro-cli", "linux"), "kiro-cli");
  });

  test("findOnPath walks a Windows PATH", () => {
    const env = { PATH: "C:\\empty;C:\\Tools" };
    const hit = path.join("C:\\Tools", "claude.exe");
    const found = findOnPath("claude", {
      platform: "win32",
      env,
      fs: {
        exists: (filePath) => filePath === hit,
        isRunnable: (filePath) => filePath === hit,
      },
    });
    assert.equal(found, hit);
  });

  test("resolveNamedBinary finds Toolbox + npm locations on Windows", () => {
    const home = "C:\\Users\\nan";
    const env = {
      PATH: "",
      LOCALAPPDATA: "C:\\Users\\nan\\AppData\\Local",
      APPDATA: "C:\\Users\\nan\\AppData\\Roaming",
    };
    const toolbox = path.join(env.LOCALAPPDATA, "Toolbox", "bin", "codex.exe");
    const result = resolveNamedBinary("codex", {
      platform: "win32",
      home,
      env,
      fs: {
        exists: (filePath) => filePath === toolbox,
        isRunnable: (filePath) => filePath === toolbox,
      },
    });
    assert.equal(result.found, toolbox);
    assert.ok(standardInstallDirs({ platform: "win32", home, env }).some((dir) => dir.includes("Toolbox")));
  });
});
