#!/usr/bin/env node
// Runs Electron smokes by name: `node scripts/run-electron-smoke.mjs <name...>`
// starts scripts/electron-<name>-smoke.cjs under this checkout's Electron, one
// after another, and fails on the first smoke that fails. Smokes open hidden
// windows, so they need a desktop session (macOS WindowServer, or a display
// such as xvfb-run on Linux) and a built electron/dist (electron:build-main).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronCli = path.join(root, "node_modules", "electron", "cli.js");

export function smokeScript(name) {
  const script = path.join(root, "scripts", `electron-${name}-smoke.cjs`);
  if (!/^[a-z][a-z-]*$/.test(name) || !existsSync(script)) {
    throw new Error(`Unknown Electron smoke: ${name}`);
  }
  return script;
}

function runSmoke(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [electronCli, script], {
      cwd: root,
      env: { ...process.env, NODE_OPTIONS: "" },
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", (error) => {
      console.error(error);
      resolve(1);
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  const names = process.argv.slice(2);
  if (names.length === 0) {
    console.error("Usage: node scripts/run-electron-smoke.mjs <name...>");
    process.exit(1);
  }
  const scripts = names.map(smokeScript);
  for (const script of scripts) {
    const code = await runSmoke(script);
    if (code !== 0) process.exit(code);
  }
}
