import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  candidateNames,
  exeName,
  findInDir,
  findOnPath,
  pathDirs,
  resolveNamedBinary,
  standardInstallDirs,
} from "../src/agents/executableLookup";

describe("executableLookup", () => {
  test("pathDirs splits on the platform delimiter", () => {
    assert.deepEqual(pathDirs("C:\\bin;D:\\tools", "win32"), ["C:\\bin", "D:\\tools"]);
    assert.deepEqual(pathDirs("/usr/bin:/opt/bin", "darwin"), ["/usr/bin", "/opt/bin"]);
  });

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

  test("findInDir prefers .exe over .cmd on Windows", () => {
    const dir = "C:\\Toolbox\\bin";
    const present = new Set([
      path.join(dir, "codex.cmd"),
      path.join(dir, "codex.exe"),
    ]);
    const found = findInDir(dir, "codex", {
      platform: "win32",
      fs: {
        exists: (filePath) => present.has(filePath),
        isRunnable: (filePath) => present.has(filePath),
      },
    });
    assert.equal(found, path.join(dir, "codex.exe"));
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

  test("resolveNamedBinary honors the env override when the file exists", () => {
    const override = "D:\\bins\\claude.exe";
    const result = resolveNamedBinary("claude", {
      platform: "win32",
      envValue: override,
      env: { PATH: "" },
      fs: {
        exists: (filePath) => filePath === override,
        isRunnable: () => false,
      },
    });
    assert.equal(result.found, override);
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

  test("resolveNamedBinary records tried paths and returns null when nothing matches", () => {
    const result = resolveNamedBinary("agy", {
      platform: "linux",
      envValue: "/missing/agy",
      env: { PATH: "/empty" },
      extraFiles: ["/opt/agy"],
      skipStandardDirs: true,
      fs: {
        exists: () => false,
        isRunnable: () => false,
      },
    });
    assert.equal(result.found, null);
    assert.ok(result.tried.includes("/missing/agy"));
    assert.ok(result.tried.includes("/opt/agy"));
  });
});
