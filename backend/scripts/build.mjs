import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { build, context } from "esbuild";

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

// Copy SQL migration files + the codex stop-hook. The runtime resolves them via
// path.join(__dirname, 'db/{migrations,auditMigrations}') in bundled mode;
// after esbuild flattens to dist/server.js, __dirname is dist/, so these must
// live at dist/db/... . Without this, runMigrations' readdirSync hits ENOENT
// and (per its catch) silently no-ops — every schema change stays unapplied.
function copyAssets() {
  copyTree(resolve(root, "src/db/migrations"), resolve(dist, "db/migrations"));
  copyTree(resolve(root, "src/db/auditMigrations"), resolve(dist, "db/auditMigrations"));
  copyTree(
    resolve(root, "src/agents/codex/codexStopHookRunner.cjs"),
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
  },
  external: [
    "node:*",
  ],
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
      env: process.env,      // inherit MICHI_DATA_DIR / PORT / etc
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
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Await the child's real exit, THEN dispose esbuild, THEN exit. Awaiting
    // (rather than fire-and-forget + process.exit) is what stops the child from
    // orphaning and holding the port past the next dev start.
    void stopChild().then(() => ctx.dispose()).finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} else {
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
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
