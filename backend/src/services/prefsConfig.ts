/**
 * Persists user UI preferences in ~/.michi/config.json under the "prefs" key.
 *
 * Only Settings-visible fields are persisted here. Transient UI state
 * (sidebarExpanded, workspaceOrder, terminalSidebarWidth, etc.) stays in
 * frontend localStorage.
 */
import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_DIR = path.join(os.homedir(), ".michi");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

/**
 * The subset of prefs that are user-facing in Settings and should survive
 * across app reinstalls / origin changes. Keep in sync with the Settings UI.
 */
const PERSISTED_KEYS: ReadonlySet<string> = new Set([
  "terminalPalette",
  "terminalAccentOverrides",
  "uiFont",
  "messageFont",
  "messageFontSize",
  "composerFontSize",
  "sidebarDensity",
  "sidebarInset",
  "codeBlockStyle",
  "codeWrap",
  "terminalDensity",
  "focusDim",
  "defaultPaneWidth",
  "singlePaneContentWidth",
  "paneRules",
  "notifications",
  "enableFollowUps",
  "bypassPermissions",
]);

function readDiskFile(): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Read persisted prefs from config.json. Returns null if no prefs exist yet.
 */
export function readPrefs(): Record<string, unknown> | null {
  const disk = readDiskFile();
  if (!disk || typeof disk !== "object") return null;
  const prefs = disk.prefs;
  if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) return null;
  return prefs as Record<string, unknown>;
}

/**
 * Write prefs to config.json. Only persists keys in PERSISTED_KEYS;
 * transient fields are silently dropped. Uses read-modify-write to
 * avoid clobbering other top-level config fields (agent, providerApiKeys).
 */
export function writePrefs(incoming: Record<string, unknown>): void {
  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(incoming)) {
    if (PERSISTED_KEYS.has(key)) {
      filtered[key] = incoming[key];
    }
  }

  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const existing = readDiskFile() ?? {};
    const merged = { ...((existing.prefs as Record<string, unknown>) ?? {}), ...filtered };
    const next = { ...existing, prefs: merged };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error("[prefsConfig] writePrefs failed:", err);
  }
}

/**
 * One-time migration: if SQLite has user_prefs but config.json doesn't have
 * a prefs key, copy the relevant fields over.
 */
export function migrateFromSqlite(sqlitePrefs: Record<string, unknown>): void {
  const existing = readDiskFile();
  if (existing?.prefs && typeof existing.prefs === "object" && Object.keys(existing.prefs).length > 0) {
    return;
  }
  console.log("[prefsConfig] Migrating user prefs from SQLite → config.json");
  writePrefs(sqlitePrefs);
}
