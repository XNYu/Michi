import fs from "fs";
import path from "path";
import os from "os";
import type { ProviderEnvBinding } from "../agents/types";
import { getUserProviderKey } from "./userKeys";

const CONFIG_DIR = path.join(os.homedir(), ".michi");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

let envBindings: ProviderEnvBinding[] = [];

/**
 * Register the provider→env-var bindings. Called once at startup by
 * server.ts after iterating RUNTIME_FACTORIES, so secrets.ts doesn't need
 * to import runtime-specific provider metadata. Idempotent — later calls
 * replace the table.
 */
export function setProviderEnvBindings(bindings: ProviderEnvBinding[]): void {
  envBindings = bindings;
}

function readDiskFile(): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

function readDiskKeys(): Record<string, string> {
  const disk = readDiskFile();
  if (!disk || typeof disk !== "object") return {};
  const out: Record<string, string> = {};
  if (disk.providerApiKeys && typeof disk.providerApiKeys === "object") {
    for (const [k, v] of Object.entries(disk.providerApiKeys)) {
      if (typeof v === "string" && v) out[k] = v;
    }
  }
  // Legacy deepseekApiKey shim
  if (typeof disk.deepseekApiKey === "string" && disk.deepseekApiKey && !out.deepseek) {
    out.deepseek = disk.deepseekApiKey;
  }
  return out;
}

function readEnvKey(provider: string): string | null {
  const binding = envBindings.find((b) => b.provider === provider);
  if (!binding) return null;
  for (const v of binding.envVars) {
    const raw = process.env[v];
    if (raw) return raw;
  }
  return null;
}

/**
 * Resolve the API key for a provider.
 *
 * Resolution order:
 *   1. If `userId` is provided (cloud / BYOK mode): the user's encrypted
 *      key in `user_provider_keys`. If that user has no key, the lookup
 *      stops here — we DO NOT fall back to env or disk because the
 *      shared keys live on the operator's server, not the user's.
 *   2. Else (desktop / dev): env var (e.g. ANTHROPIC_API_KEY) wins,
 *      then disk-stored key in ~/.michi/config.json.
 */
export function getProviderApiKey(provider: string, userId?: string): string | null {
  if (userId) {
    return getUserProviderKey(userId, provider);
  }
  const fromEnv = readEnvKey(provider);
  if (fromEnv) return fromEnv;
  const keys = readDiskKeys();
  return keys[provider] ?? null;
}

export function listProviderKeyPresence(providers: string[]): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const p of providers) result[p] = !!getProviderApiKey(p);
  return result;
}

export function setProviderApiKey(provider: string, key: string | null): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const disk = readDiskFile() ?? {};
  const keys = (disk.providerApiKeys && typeof disk.providerApiKeys === "object")
    ? { ...disk.providerApiKeys }
    : {};
  if (key) keys[provider] = key;
  else delete keys[provider];
  // Also clear the legacy deepseek slot when deepseek changes
  if (provider === "deepseek") {
    if (key) disk.deepseekApiKey = key;
    else delete disk.deepseekApiKey;
  }
  const next = { ...disk, providerApiKeys: keys };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
}

// TODO: macOS Keychain backing (keytar/security CLI) goes here.
