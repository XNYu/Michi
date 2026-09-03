#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const waitOn = require("wait-on");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const url = process.env.MICHI_RENDERER_URL || "http://127.0.0.1:3001";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      shell: process.platform === "win32",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

await waitOn({ resources: [url], timeout: 120_000 });
await run(npm, ["run", "electron:build-main"]);
await run(npm, ["run", "electron:rebuild-native"]);

const electronCli = path.join(root, "node_modules", "electron", "cli.js");
const debugPort = process.env.ELECTRON_DEBUG_PORT || "9222";
const child = spawn(
  process.execPath,
  [electronCli, `--remote-debugging-port=${debugPort}`, path.join("electron", "dist", "main.js")],
  {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: "", ELECTRON_DEV: "1" },
    stdio: "inherit",
    windowsHide: true,
  },
);

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
