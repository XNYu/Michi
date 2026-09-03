#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareElectronBinary } from "./prepare-electron-binary.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const prebuild = resolve(
  root,
  "node_modules",
  "node-pty",
  "prebuilds",
  `${process.platform}-${process.arch}`,
  "pty.node",
);

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      shell: process.platform === "win32",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

await prepareElectronBinary({ rootDir: root, log: console.log });

try {
  await run(npm, ["exec", "--", "electron-builder", "install-app-deps"]);
} catch (error) {
  if (process.platform === "win32" && existsSync(prebuild)) {
    console.warn(
      `[electron] install-app-deps failed (${error.message}); using node-pty prebuild ${prebuild}`,
    );
  } else {
    throw error;
  }
}

await import("./prepare-node-pty.mjs");
