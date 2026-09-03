#!/usr/bin/env node
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findOpenPort } from "./find-open-port.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd ?? root,
      env: opts.env ?? process.env,
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

await run(npm, ["run", "shared:build"]);

const port = process.env.MICHI_RENDERER_PORT
  ? Number(process.env.MICHI_RENDERER_PORT)
  : await findOpenPort(3001);
if (!Number.isInteger(port) || port < 1) {
  throw new Error("MICHI_RENDERER_PORT must be a positive integer");
}

const instanceId = process.env.MICHI_DEV_INSTANCE_ID || path.basename(root);
const dataDir = process.env.MICHI_DATA_DIR || path.join(os.homedir(), ".michi-dev");
const env = {
  ...process.env,
  MICHI_RENDERER_PORT: String(port),
  MICHI_RENDERER_URL: process.env.MICHI_RENDERER_URL || `http://127.0.0.1:${port}`,
  MICHI_DATA_DIR: dataDir,
  MICHI_DEV_INSTANCE_ID: instanceId,
  MICHI_ELECTRON_USER_DATA_DIR:
    process.env.MICHI_ELECTRON_USER_DATA_DIR || path.join(dataDir, `electron-${instanceId}`),
};

console.log(`[electron:dev] renderer ${env.MICHI_RENDERER_URL} instance ${instanceId}`);

const children = [
  spawn(npm, ["run", "dev:raw"], {
    cwd: path.join(root, "backend"),
    env,
    stdio: "inherit",
    shell: true,
    windowsHide: true,
  }),
  spawn(npm, ["run", "dev:raw", "--", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: path.join(root, "frontend"),
    env,
    stdio: "inherit",
    shell: true,
    windowsHide: true,
  }),
  spawn(npm, ["run", "electron:dev-wait"], {
    cwd: root,
    env,
    stdio: "inherit",
    shell: true,
    windowsHide: true,
  }),
];

let exiting = false;
function shutdown() {
  if (exiting) return;
  exiting = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.all(
  children.map(
    (child) =>
      new Promise((resolve) => {
        child.on("exit", (code) => {
          if (!exiting && code) process.exitCode = code;
          shutdown();
          resolve();
        });
      }),
  ),
);
