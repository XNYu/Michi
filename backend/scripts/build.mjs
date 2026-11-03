import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { build, context } from "esbuild";
import { michiBuildInfo } from "../../scripts/build-info.mjs";
import { BuildReadiness } from "./buildReadiness.mjs";

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
  const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
  copyTree(join(piRoot, 'package.json'), join(dist, 'pi-sdk/package.json'));
  copyTree(resolve(root, 'src/agents/pi/PI-LICENSE.txt'), join(dist, 'pi-sdk/LICENSE.txt'));

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

// Options every bundle shares; bundleOptions() adds each entry's own fields.
const baseOptions = {
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

// crewMcpHost.js reloads crewMcp.js while it runs, so that bundle is written
// to a temporary file and renamed into place instead of being written in place.
const atomicCrewRelay = { name: "atomic-crew-relay", setup(pluginBuild) {
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
} };

// One row per bundle, in build order. Output file names are loaded by name
// elsewhere, so do not rename them. Fields: entry (relative to backend/),
// outfile, extra define/external, atomicWrite (write through atomicCrewRelay),
// restartKey (--watch waits for server + SDK, then restarts the child).
const bundles = [
  // Native ESM preserves SDK/provider import.meta-based resource loading.
  { entry: "src/agents/pi/piSdkBundle.ts", outfile: resolve(dist, "pi-sdk/sdk.mjs"),
    restartKey: "sdk", format: "esm", banner: { js: 'import { createRequire as michiCreateRequire } from "node:module"; const require = michiCreateRequire(import.meta.url);' } },
  // Meta agent metrics worker thread, loaded by name like the database worker.
  { entry: "src/services/metaAgentMetricsWorker.ts", outfile: resolve(dist, "metaAgentMetricsWorker.js") },
  // Database worker thread, loaded by `new Worker('dist/dbWorkerThread.js')`.
  { entry: "src/services/dbWorkerThread.ts", outfile: resolve(dist, "dbWorkerThread.js") },
  // Crew ACP adapter — its own process, launched by the `crew` runtime as
  // `node dist/crewAcp.js acp ...` (see runtime/src/adapters/crew/crewLaunch.ts).
  { entry: "../runtime/src/adapters/crew/acp/main.ts", outfile: resolve(dist, "crewAcp.js") },
  { entry: "../runtime/src/adapters/crew/crewMcpMain.ts", outfile: resolve(dist, "crewMcp.js"), atomicWrite: true },
  { entry: "../runtime/src/adapters/crew/crewMcpHost.ts", outfile: resolve(dist, "crewMcpHost.js") },
  {
    entry: "src/server.ts",
    outfile: stagedOutfile,
    define: WATCH ? {} : { __MICHI_BUILD_INFO__: JSON.stringify(michiBuildInfo(resolve(root, '..'))) },
    external: [
      "@anthropic-ai/claude-agent-sdk", // source execution; bundles load dist/claude-sdk
    ],
    restartKey: "server",
  },
];

function bundleOptions(entry, extraPlugins = []) {
  const plugins = [...(entry.atomicWrite ? [atomicCrewRelay] : []), ...extraPlugins];
  return {
    ...baseOptions,
    ...(entry.format ? { format: entry.format } : {}),
    ...(entry.banner ? { banner: entry.banner } : {}),
    entryPoints: [resolve(root, entry.entry)],
    outfile: entry.outfile,
    define: { ...baseOptions.define, ...entry.define },
    external: [...baseOptions.external, ...(entry.external ?? [])],
    ...(entry.atomicWrite ? { write: false } : {}),
    ...(plugins.length ? { plugins } : {}),
  };
}

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

  const readiness = new BuildReadiness(['sdk', 'server']);
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
    if (shuttingDown || !readiness.ready) return;
    await stopChild();
    if (shuttingDown || !readiness.ready) return;
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
  const runOnRebuild = (key) => ({
    name: "run-on-rebuild",
    setup(pluginBuild) {
      pluginBuild.onStart(() => { readiness.started(key); });
      pluginBuild.onEnd((result) => {
        if (result.errors.length > 0) {
          console.error(`[backend] build failed (${result.errors.length} error(s)); keeping previous server`);
          return;
        }
        readiness.succeeded(key);
        copyAssets();
        if (key === 'server' && stagedOutfile !== outfile) copyTree(stagedOutfile, outfile);
        chain = chain.then(startServer).catch((err) => console.error("[backend] restart failed:", err));
      });
    },
  });
  // SDK changes require a process restart because native ESM imports are cached.
  // Remaining bundles are picked up when next loaded: the server's Worker
  // constructor, the next Crew adapter spawn, crewMcpHost's relay reload.
  const contexts = [];
  for (const entry of bundles) {
    const ctx = await context(bundleOptions(entry, entry.restartKey ? [runOnRebuild(entry.restartKey)] : []));
    await ctx.watch();
    contexts.push(ctx);
  }
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void stopChild()
      .then(() => Promise.all(contexts.map((ctx) => ctx.dispose())))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} else {
  for (const entry of bundles) await build(bundleOptions(entry));
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
