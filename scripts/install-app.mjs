#!/usr/bin/env node
// Copy the built michi.app into ~/Applications so Spotlight/Launchpad pick up
// the new bundle. This is the only copy step: `npm run electron:build` runs it
// as postelectron:build (install.sh and `michi update` build that way), and
// bin/michi runs it with --if-newer before opening the app.
//
// Usage: node scripts/install-app.mjs [--if-newer]
//   --if-newer  leave an installed bundle alone unless the build is newer

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILT_APP = join(repoRoot, 'dist-electron', 'mac-arm64', 'michi.app');

function installWindowsShortcut() {
  // On Windows, create a Start Menu shortcut to the unpacked exe.
  const src = join(repoRoot, 'dist-electron', 'win-unpacked', 'michi.exe');
  if (!existsSync(src)) {
    // NSIS installer was produced instead of unpacked dir — nothing to shortcut.
    console.log('install-app: win-unpacked not found (NSIS build); skipping shortcut');
    return;
  }

  const startMenu = join(
    process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs',
  );
  const lnk = join(startMenu, 'Michi.lnk');

  // Use PowerShell to create a .lnk — no native Node API for this.
  const ps = [
    `$ws = New-Object -ComObject WScript.Shell`,
    `$sc = $ws.CreateShortcut('${lnk.replace(/'/g, "''")}')`,
    `$sc.TargetPath = '${src.replace(/'/g, "''")}'`,
    `$sc.WorkingDirectory = '${repoRoot.replace(/'/g, "''")}'`,
    `$sc.Description = 'Michi — branching AI workspace'`,
  ];
  const iconPath = join(repoRoot, 'assets', 'icons', 'icon.ico');
  if (existsSync(iconPath)) {
    ps.push(`$sc.IconLocation = '${iconPath.replace(/'/g, "''")}'`);
  }
  ps.push(`$sc.Save()`);

  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps.join('; ')], {
      stdio: 'ignore',
      windowsHide: true,
    });
    console.log(`install-app: Start Menu shortcut → ${lnk}`);
  } catch {
    console.log(`install-app: could not create shortcut (non-fatal)`);
  }

  console.log(`install-app: portable exe → ${src}`);
  return;
}

function quitRunningApp() {
  // cp -R over a live bundle corrupts the running process.
  spawnSync('osascript', ['-e', 'tell application "michi" to quit'], { stdio: 'ignore' });
}

function registerInstalledApp(dst) {
  // Defensive: strip quarantine + nudge Spotlight. Failures here are non-fatal.
  try { execFileSync('xattr', ['-dr', 'com.apple.quarantine', dst], { stdio: 'ignore' }); } catch {}
  try { execFileSync('mdimport', [dst], { stdio: 'ignore' }); } catch {}
}

/** Installs src as <dstDir>/michi.app. Returns 'installed', or 'current' when
 *  ifNewer is set and the installed bundle is not older than src. */
export function installApp({
  src = BUILT_APP,
  dstDir = join(homedir(), 'Applications'),
  ifNewer = false,
  quit = quitRunningApp,
  register = registerInstalledApp,
} = {}) {
  if (!existsSync(src)) {
    throw new Error(`built app not found at ${src}\n  run \`npm run electron:build\` first`);
  }
  const dst = join(dstDir, 'michi.app');
  if (ifNewer && existsSync(dst) && statSync(src).mtimeMs <= statSync(dst).mtimeMs) return 'current';

  quit();
  mkdirSync(dstDir, { recursive: true });
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
  register(dst);
  return 'installed';
}

function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((arg) => arg !== '--if-newer');
  if (unknown.length > 0) throw new Error(`unknown option: ${unknown[0]}\nUsage: node scripts/install-app.mjs [--if-newer]`);
  if (platform() === 'win32') {
    installWindowsShortcut();
    return;
  }
  if (platform() !== 'darwin') {
    console.log('install-app: non-Darwin/non-Windows host, skipping');
    return;
  }
  const dstDir = join(homedir(), 'Applications');
  if (installApp({ dstDir, ifNewer: argv.includes('--if-newer') }) === 'installed') {
    console.log(`install-app: installed → ${join(dstDir, 'michi.app')}`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(`install-app: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
