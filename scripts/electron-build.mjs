#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const extra = process.argv.slice(2);

function defaultBuilderArgs() {
  if (process.platform === "win32") return ["--win", "--x64"];
  if (process.platform === "darwin") return ["--mac", "--arm64"];
  return ["--linux", "--x64"];
}

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
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

await run(npm, ["run", "frontend:build"], { ...process.env, VITE_API_URL: "/api" });
await run(npm, ["run", "backend:build"]);
await run(npm, ["run", "electron:build-main"]);
await run(npm, ["run", "electron:rebuild-native"]);
await run(npm, ["exec", "--", "electron-builder", ...(extra.length > 0 ? extra : defaultBuilderArgs())]);
