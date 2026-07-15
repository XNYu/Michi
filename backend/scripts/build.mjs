import { cpSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const outfile = resolve(dist, "server.js");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

rmSync(dist, { recursive: true, force: true });

// Copy SQL migration files. The runtime resolves them via
// path.join(__dirname, '../db/{migrations,auditMigrations}'); after esbuild
// flattens to dist/server.js, __dirname is dist/, so the SQL must live at
// dist/db/{migrations,auditMigrations}/. Without this, runMigrations'
// readdirSync hits ENOENT and (per its catch) silently no-ops — every
// schema change since P0 stays unapplied.
cpSync(resolve(root, "src/db/migrations"), resolve(dist, "db/migrations"), { recursive: true });
cpSync(resolve(root, "src/db/auditMigrations"), resolve(dist, "db/auditMigrations"), { recursive: true });
cpSync(
  resolve(root, "src/agents/codex/codexStopHookRunner.cjs"),
  resolve(dist, "codexStopHookRunner.cjs"),
);

await build({
  entryPoints: [resolve(root, "src/server.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: process.env.SOURCEMAP === "1",
  legalComments: "none",
  define: {
    __MICHIBUNDLE__: "true",
  },
  external: [
    "node:*",
  ],
});

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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
