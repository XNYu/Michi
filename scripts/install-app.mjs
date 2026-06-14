#!/usr/bin/env node
// Copy the freshly built michi.app into ~/Applications so Spotlight/Launchpad
// pick up the new bundle. Mirrors the [8/9] step of install.sh — keep them in
// sync if you change behavior here.

import { execSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (platform() !== 'darwin') {
  console.log('install-app: non-Darwin host, skipping');
  process.exit(0);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(repoRoot, 'dist-electron', 'mac-arm64', 'michi.app');
const dstDir = join(homedir(), 'Applications');
const dst = join(dstDir, 'michi.app');

if (!existsSync(src)) {
  console.error(`install-app: built app not found at ${src}`);
  console.error('  run `npm run electron:build` first');
  process.exit(1);
}

// Quit any running copy — cp -R over a live bundle corrupts the running process.
spawnSync('osascript', ['-e', 'tell application "michi" to quit'], { stdio: 'ignore' });

mkdirSync(dstDir, { recursive: true });
rmSync(dst, { recursive: true, force: true });
cpSync(src, dst, { recursive: true, verbatimSymlinks: true });

// Defensive: strip quarantine + nudge Spotlight. Failures here are non-fatal.
try { execSync(`xattr -dr com.apple.quarantine "${dst}"`, { stdio: 'ignore' }); } catch {}
try { execSync(`mdimport "${dst}"`, { stdio: 'ignore' }); } catch {}

console.log(`install-app: installed → ${dst}`);
