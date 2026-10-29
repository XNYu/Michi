#!/usr/bin/env node
// Root `dev` (backend + frontend) and `backend:dev` (--backend-only). The data
// defaults are applied here rather than inline in package.json because npm
// runs scripts with cmd.exe on Windows, which has no `VAR=value cmd` syntax.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { devDataEnvironment } from "./electron-dev-env.mjs";
import { npm } from "./lib/proc.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = devDataEnvironment(process.env);
const options = { env, stdio: "inherit", windowsHide: true };

function concurrentlyCli() {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve("concurrently/package.json");
  return path.join(path.dirname(manifest), require(manifest).bin.concurrently);
}

const child = process.argv.includes("--backend-only")
  ? spawn(npm, ["run", "dev:raw"], {
      ...options,
      cwd: path.join(root, "backend"),
      shell: process.platform === "win32",
    })
  : spawn(
      process.execPath,
      [concurrentlyCli(), "cd backend && npm run dev:raw", "cd frontend && npm run dev:raw"],
      { ...options, cwd: root },
    );

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
