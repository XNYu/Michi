#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareElectronBinary } from "./prepare-electron-binary.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

// node-pty is an N-API module, so the pty.node it ships in prebuilds/ loads in
// Electron without recompiling. On these platforms a failed Electron rebuild
// falls back to that prebuild instead of failing the install. On macOS this
// covers toolchain mismatches such as an older selected Xcode whose linker
// cannot read a newer SDK's .tbd stubs.
const PREBUILD_FALLBACK_PLATFORMS = new Set(["darwin", "win32"]);

export function nativeBuildEnvironment({
  env = process.env,
  platform = process.platform,
  resolveSdk = (buildEnv) => execFileSync(
    "/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"],
    { env: buildEnv, encoding: "utf8", timeout: 10_000 },
  ),
  warn = console.warn,
} = {}) {
  if (platform !== "darwin" || env.SDKROOT) return env;
  try {
    // Unqualified SDK discovery can pick the Command Line Tools SDK even when
    // xcode-select points to an older Xcode. Explicitly select macosx so the
    // SDK comes from the selected developer directory, matching Apple's tools.
    const sdkRoot = resolveSdk(env).trim();
    if (!sdkRoot) throw new Error("xcrun returned an empty SDK path");
    return { ...env, SDKROOT: sdkRoot };
  } catch (error) {
    // SDK discovery must not prevent the existing prebuild fallback on Macs
    // without a usable toolchain.
    warn(`[electron] Could not resolve the macOS SDK (${error.message}); keeping the existing build environment`);
    return env;
  }
}

export function nodePtyPaths(rootDir, platform = process.platform, arch = process.arch) {
  const packageDir = resolve(rootDir, "node_modules", "node-pty");
  return {
    buildDir: resolve(packageDir, "build"),
    prebuild: resolve(packageDir, "prebuilds", `${platform}-${arch}`, "pty.node"),
  };
}

export async function rebuildNativeModules({
  rootDir,
  installAppDeps,
  platform = process.platform,
  arch = process.arch,
  warn = console.warn,
}) {
  try {
    await installAppDeps();
    return { usedPrebuild: false };
  } catch (error) {
    const { buildDir, prebuild } = nodePtyPaths(rootDir, platform, arch);
    if (!PREBUILD_FALLBACK_PLATFORMS.has(platform) || !existsSync(prebuild)) throw error;
    warn(`[electron] install-app-deps failed (${error.message}); using node-pty prebuild ${prebuild}`);
    if (platform === "darwin") {
      // node-pty loads build/Release before prebuilds/ and takes spawn-helper
      // from the same directory as pty.node. Remove any partial rebuild so both
      // come from the prebuild.
      rmSync(buildDir, { recursive: true, force: true });
    }
    return { usedPrebuild: true };
  }
}

function run(command, args, env = process.env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
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

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  await prepareElectronBinary({ rootDir: root, log: console.log });
  const env = nativeBuildEnvironment();
  await rebuildNativeModules({
    rootDir: root,
    installAppDeps: () => run(npm, ["exec", "--", "electron-builder", "install-app-deps"], env),
  });
  await import("./prepare-node-pty.mjs");
}
