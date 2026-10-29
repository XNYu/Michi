import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { build, context } from "esbuild";
import { michiBuildInfo } from "../../scripts/build-info.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const outfile = resolve(dist, "server.js");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

// esbuild's native writer STATUS_STACK_BUFFER_OVERRUN-crashes on some Windows
// OneDrive / non-ASCII checkout paths. Stage the bundle on a short TEMP path
// and copy it into dist/ afterwards.
function stagingOutfile() {
  if (process.platform !== "win32") return outfile;
  return join(tmpdir(), `michi-backend-${process.pid}-${randomBytes(4).toString("hex")}.js`);
}

/** Recursive copy that avoids `fs.cpSync`, which STATUS_STACK_BUFFER_OVERRUN-crashes
 *  on some Windows OneDrive / non-ASCII checkout paths (Node 24). */
function copyTree(src, dest) {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) {
      copyTree(join(src, name), join(dest, name));
    }
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

// `--watch` (dev): rebuild the bundle on source change and (re)start the server
// child on each successful rebuild. This is the fast dev loop — cold boot from
// the bundle is ~0.5s vs ~10s for ts-node's per-start type-check + transpile.
const WATCH = process.argv.includes("--watch");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// Copy SQL migration files + the codex stop-hook. The runtime resolves them via
// path.join(__dirname, 'db/{migrations,auditMigrations}') in bundled mode;
// after esbuild flattens to dist/server.js, __dirname is dist/, so these must
// live at dist/db/... . Without this, runMigrations' readdirSync hits ENOENT
// and (per its catch) silently no-ops — every schema change stays unapplied.
function copyAssets() {
  // Keep the SDK's native ESM entry and sibling modules beside the CJS bundle.
  // Claude itself remains the user's installed CLI, selected by the runtime.
  const sdkRoot = dirname(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'));
  for (const name of readdirSync(sdkRoot)) {
    if (/\.(mjs|js|json)$/.test(name) || name === 'LICENSE.md' || name === 'README.md') {
      copyTree(join(sdkRoot, name), join(dist, 'claude-sdk', name));
    }
  }
  // Keep Agent help available offline in source installs and packaged Electron.
  const docs = JSON.parse(readFileSync(resolve(root, "src/docs/catalog.json"), "utf8"));
  for (const doc of docs) {
    const source = resolve(root, "src", doc.source);
    if (!existsSync(source)) {
      throw new Error(`Help doc "${doc.id}" in src/docs/catalog.json has no source file: ${source} (in Docker builds, check .dockerignore)`);
    }
    copyTree(source, resolve(dist, "docs", `${doc.id}.md`));
  }
  // The official Crew launcher uses the same Node that built this installation.
  writeFileSync(resolve(dist, "crew-node.json"), JSON.stringify({ schemaVersion: 1, node: process.execPath, nodeVersion: process.versions.node }) + "\n");
  copyTree(resolve(root, "src/db/migrations"), resolve(dist, "db/migrations"));
  copyTree(resolve(root, "src/db/auditMigrations"), resolve(dist, "db/auditMigrations"));
  // The Codex adapter finds its runner beside the bundle (codexFollowUpsHookPoc).
  copyTree(
    resolve(root, "../runtime/src/adapters/codex/assets/codexStopHookRunner.cjs"),
    resolve(dist, "codexStopHookRunner.cjs"),
  );
}
copyAssets();

const stagedOutfile = stagingOutfile();
const buildOptions = {
  entryPoints: [resolve(root, "src/server.ts")],
  outfile: stagedOutfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: process.env.SOURCEMAP === "1" || WATCH,
  legalComments: "none",
  define: {
    __MICHIBUNDLE__: "true",
    ...(WATCH ? {} : { __MICHI_BUILD_INFO__: JSON.stringify(michiBuildInfo(resolve(root, '..'))) }),
  },
  external: [
    "node:*",
    "@anthropic-ai/claude-agent-sdk", // source execution; bundles load dist/claude-sdk
  ],
};

// Database worker thread — bundled as a separate entry point so
// `new Worker('dist/dbWorkerThread.js')` can load it independently.
const workerBuildOptions = {
  entryPoints: [resolve(root, "src/services/dbWorkerThread.ts")],
  outfile: resolve(dist, "dbWorkerThread.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: process.env.SOURCEMAP === "1" || WATCH,
  legalComments: "none",
  define: {
    __MICHIBUNDLE__: "true",
  },
  external: [
    "node:*",
  ],
};

const metricsWorkerBuildOptions = {
  ...workerBuildOptions,
  entryPoints: [resolve(root, "src/services/metaAgentMetricsWorker.ts")],
  outfile: resolve(dist, "metaAgentMetricsWorker.js"),
};

// Crew ACP adapter — its own process, launched by the `crew` runtime as
// `node dist/crewAcp.js acp ...` (see runtime/src/adapters/crew/crewLaunch.ts).
const crewAcpBuildOptions = {
  ...workerBuildOptions,
  entryPoints: [resolve(root, "../runtime/src/adapters/crew/acp/main.ts")],
  outfile: resolve(dist, "crewAcp.js"),
};

const crewMcpBuildOptions = {
  ...workerBuildOptions,
  entryPoints: [resolve(root, "../runtime/src/adapters/crew/crewMcpMain.ts")],
  outfile: resolve(dist, "crewMcp.js"),
  write: false,
  plugins: [{ name: "atomic-crew-relay", setup(pluginBuild) {
    pluginBuild.onEnd((result) => {
      if (result.errors.length) return;
      for (const file of result.outputFiles ?? []) {
        const temporary = `${file.path}.${process.pid}.tmp`;
        try {
          mkdirSync(dirname(file.path), { recursive: true });
          writeFileSync(temporary, file.contents);
          renameSync(temporary, file.path);
        } finally { rmSync(temporary, { force: true }); }
      }
    });
  } }],
};

const crewMcpHostBuildOptions = {
  ...workerBuildOptions,
  entryPoints: [resolve(root, "../runtime/src/adapters/crew/crewMcpHost.ts")],
  outfile: resolve(dist, "crewMcpHost.js"),
};

if (WATCH) {
  // Dev: watch + run in one process. esbuild rebuilds dist/server.js on each
  // source change (incremental, fast); after every successful rebuild we
  // (re)start the bundled server. Cold boot from the bundle is ~0.5s vs ~10s
  // for ts-node's per-start type-check + transpile. The bundle is byte-
  // identical to prod (`define`, `external`, asset layout all shared), so dev
  // and prod can't drift.
  //
  // Child lifecycle follows the repo's own acpClient pattern: spawn the server
  // `detached` so it leads its OWN process group, then signal the whole group
  // with kill(-pid). That reliably takes down the server AND any subprocesses
  // it spawned (ACP/kiro/claude), which a bare child.kill() would orphan.
  try {
    checkRuntimeBoundary({ watch: true });
  } catch (err) {
    console.warn("[backend] runtime boundary check could not run:", err);
  }

  let child = null;
  let shuttingDown = false;

  const killGroup = (proc, signal) => {
    if (!proc?.pid) return;
    if (process.platform === "win32") {
      const force = signal === "SIGKILL";
      try {
        execFileSync("taskkill", force ? ["/F", "/T", "/PID", String(proc.pid)] : ["/T", "/PID", String(proc.pid)], {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        try { proc.kill(signal); } catch { /* already gone */ }
      }
      return;
    }
    try { process.kill(-proc.pid, signal); }
    catch { try { proc.kill(signal); } catch { /* already gone */ } }
  };

  // Resolve once the current server has fully exited. The backend's own
  // SIGTERM handler drains ACP sessions + closes the HTTP listener (≤5s
  // watchdog), so we MUST await its exit before spawning the next one, or the
  // restart races it for the port → EADDRINUSE. No-op if nothing is running.
  const stopChild = () => new Promise((res) => {
    const c = child;
    child = null;
    if (!c || c.exitCode !== null || c.signalCode !== null) return res();
    c.once("exit", () => res());
    killGroup(c, "SIGTERM");
    // Backstop: force-kill the group if it outlives the backend's own watchdog.
    setTimeout(() => { if (c.exitCode === null && c.signalCode === null) killGroup(c, "SIGKILL"); }, 6000).unref();
  });

  const startServer = async () => {
    if (shuttingDown) return;
    await stopChild();
    if (shuttingDown) return;
    const c = spawn(process.execPath, [outfile], {
      stdio: "inherit",
      // MICHI_DEV_RENDERER: trust `npm run dev`'s Vite renderer on loopback
      // :3001 (services/localOrigins.ts). Only this watch build sets it.
      env: { ...process.env, NODE_ENV: 'development', MICHI_DEV_RENDERER: '1' },
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    child = c;
    c.on("exit", (code, signal) => {
      if (!shuttingDown && child === c && signal == null && code !== 0) {
        console.error(`[backend] exited with code ${code}`);
      }
    });
  };

  // Serialize restarts so two fast saves can't spawn two servers racing the port.
  let chain = Promise.resolve();
  const runOnRebuild = {
    name: "run-on-rebuild",
    setup(pluginBuild) {
      pluginBuild.onEnd((result) => {
        if (result.errors.length > 0) {
          console.error(`[backend] build failed (${result.errors.length} error(s)); keeping previous server`);
          return;
        }
        copyAssets();
        if (stagedOutfile !== outfile) copyTree(stagedOutfile, outfile);
        chain = chain.then(startServer).catch((err) => console.error("[backend] restart failed:", err));
      });
    },
  };
  const ctx = await context({ ...buildOptions, plugins: [runOnRebuild] });
  await ctx.watch();
  // Worker thread bundle: rebuild alongside the main server but no restart
  // trigger — the main server's Worker constructor loads the fresh file.
  const metricsWorkerCtx = await context(metricsWorkerBuildOptions);
  await metricsWorkerCtx.watch();
  const workerCtx = await context(workerBuildOptions);
  await workerCtx.watch();
  // Crew ACP adapter: same as the worker, picked up on the next adapter spawn.
  const crewAcpCtx = await context(crewAcpBuildOptions);
  await crewAcpCtx.watch();
  const crewMcpCtx = await context(crewMcpBuildOptions);
  await crewMcpCtx.watch();
  const crewMcpHostCtx = await context(crewMcpHostBuildOptions);
  await crewMcpHostCtx.watch();
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void stopChild()
      .then(() => Promise.all([ctx.dispose(), metricsWorkerCtx.dispose(), workerCtx.dispose(), crewAcpCtx.dispose(), crewMcpCtx.dispose(), crewMcpHostCtx.dispose()]))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} else {
  await build(metricsWorkerBuildOptions);
  await build(workerBuildOptions);
  await build(crewAcpBuildOptions);
  await build(crewMcpBuildOptions);
  await build(crewMcpHostBuildOptions);
  await build(buildOptions);
  if (stagedOutfile !== outfile) {
    copyTree(stagedOutfile, outfile);
    rmSync(stagedOutfile, { force: true });
  }

  const bundled = readFileSync(outfile, "utf8");
  const runtimeDeps = Object.keys(packageJson.dependencies ?? {});
  const unresolvedRuntimeImport = runtimeDeps.length
    ? new RegExp(
        String.raw`\b(?:require|import)\s*\(\s*["'](?:${runtimeDeps.map(escapeRegExp).join("|")})(?:/[^"']*)?["']\s*\)`,
      )
    : null;

  if (unresolvedRuntimeImport?.test(bundled)) {
    throw new Error("Backend bundle still contains unresolved runtime dependency imports");
  }

  checkRuntimeBoundary({ watch: false });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Runtime package boundary ratchet (scripts/runtimeBoundary.cjs; see AGENTS.md).
// New runtime-layer imports of app code, process.env reads in runtime files, or
// runtime-id comparisons outside adapter directories fail a normal build; the
// --watch dev loop only warns so a work-in-progress edit never blocks it.
function checkRuntimeBoundary({ watch }) {
  const { runCheck } = createRequire(import.meta.url)("./runtimeBoundary.cjs");
  const result = runCheck();
  if (!result.hasAdded) {
    console.log(`[backend] ${result.summary}`);
    return;
  }
  if (watch) {
    const rule = "!".repeat(78);
    console.warn(`\n${rule}\n[backend] WARNING: new runtime boundary entries; \`npm run build\` will fail on these.\n\n${result.failure}\n${rule}\n`);
    return;
  }
  console.error(`[backend] ${result.summary}\n\n${result.failure}`);
  process.exit(1);
}
