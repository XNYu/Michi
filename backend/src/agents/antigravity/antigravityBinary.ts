import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class AntigravityBinaryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AntigravityBinaryNotFoundError";
  }
}

export const MIN_TESTED_ANTIGRAVITY_VERSION = "1.1.1";

let cachedBinary: string | null = null;

export function resetAntigravityBinaryCacheForTest(): void {
  cachedBinary = null;
}

/** Locate the public `agy` CLI without relying on an interactive shell. */
export function findAntigravityBinary(): string {
  if (cachedBinary) return cachedBinary;

  const tried: string[] = [];
  const override = process.env.ANTIGRAVITY_CLI_BIN;
  if (override) {
    tried.push(override);
    if (fs.existsSync(override)) return (cachedBinary = override);
  }

  try {
    tried.push("<PATH lookup via which agy>");
    const found = execSync("which agy", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (found && fs.existsSync(found)) return (cachedBinary = found);
  } catch {
    // Continue through GUI/Electron-safe absolute paths.
  }

  const candidates = [
    path.join(os.homedir(), ".local", "bin", "agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
  ];
  for (const candidate of candidates) {
    tried.push(candidate);
    if (fs.existsSync(candidate)) return (cachedBinary = candidate);
  }

  throw new AntigravityBinaryNotFoundError(
    `Antigravity CLI (agy) not found. Tried: ${tried.join(", ")}. ` +
      "Install it with `brew install --cask antigravity-cli`, run `agy` once to sign in, " +
      "or set ANTIGRAVITY_CLI_BIN.",
  );
}

/** Advisory only: runtime use should not fail solely because version probing failed. */
export function warnIfAntigravityVersionBelowMinimum(): void {
  try {
    const output = execFileSync(findAntigravityBinary(), ["--version"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15_000,
    }).trim();
    const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) return;
    const current = match.slice(1).map(Number);
    const minimum = MIN_TESTED_ANTIGRAVITY_VERSION.split(".").map(Number);
    const below = current.some((value, index) => {
      if (value === minimum[index]) return false;
      return current.slice(0, index).every((part, i) => part === minimum[i]) && value < minimum[index];
    });
    if (below) {
      console.warn(
        `[michi] Antigravity CLI ${output} is below the minimum tested version ` +
          `${MIN_TESTED_ANTIGRAVITY_VERSION}. Run: agy update`,
      );
    }
  } catch {
    // Version checks are advisory.
  }
}
