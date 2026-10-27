/**
 * Persists user UI preferences in the selected config.json under the "prefs" key.
 *
 * Only Settings-visible fields are persisted here. Transient UI state
 * (sidebarExpanded, workspaceOrder, terminalSidebarWidth, etc.) stays in
 * frontend localStorage.
 */
import { readJsonConfig, updateJsonConfig } from "./jsonConfigStore";
import { getMichiConfigPaths } from './configPaths';

const { configPath: CONFIG_PATH } = getMichiConfigPaths();

/**
 * The subset of prefs that are user-facing in Settings and should survive
 * across app reinstalls / origin changes. Keep in sync with the Settings UI.
 */
const PERSISTED_KEYS: ReadonlySet<string> = new Set([
  "linkOpenTarget",
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
  "enableKiroSidecarTitles",
  "enableFollowUps",
]);

function readDiskFile(): Record<string, any> | null {
  return readJsonConfig(CONFIG_PATH);
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

  updateJsonConfig(CONFIG_PATH, (existing) => {
    const prefs = existing.prefs && typeof existing.prefs === 'object' && !Array.isArray(existing.prefs)
      ? existing.prefs : {};
    return { ...existing, prefs: { ...prefs, ...filtered } };
  });
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
