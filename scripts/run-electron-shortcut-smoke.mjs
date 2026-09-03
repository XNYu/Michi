#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronCli = path.join(root, "node_modules", "electron", "cli.js");
const script = path.join(root, "scripts", "electron-native-shortcut-smoke.cjs");

const child = spawn(process.execPath, [electronCli, script], {
  cwd: root,
  env: { ...process.env, NODE_OPTIONS: "" },
  stdio: "inherit",
  windowsHide: true,
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
