#!/usr/bin/env node
import { npm, run } from "./lib/proc.mjs";

const extra = process.argv.slice(2);

function defaultBuilderArgs() {
  if (process.platform === "win32") return ["--win", "--x64"];
  if (process.platform === "darwin") return ["--mac", "--arm64"];
  return ["--linux", "--x64"];
}

// frontend/.env.production already sets VITE_API_URL=/api, but Vite lets the
// process environment override .env files. Setting it here keeps a
// VITE_API_URL left in the developer's shell out of the packaged app, which
// must call its own backend at the same-origin /api. Keep both.
await run(npm, ["run", "frontend:build"], { env: { ...process.env, VITE_API_URL: "/api" } });
await run(npm, ["run", "backend:build"]);
await run(npm, ["run", "electron:build-main"]);
await run(npm, ["run", "electron:rebuild-native"]);
await run(npm, ["exec", "--", "electron-builder", ...(extra.length > 0 ? extra : defaultBuilderArgs())]);
