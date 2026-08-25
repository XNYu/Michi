/**
 * Pure GitHub-release helpers used by the packaged auto-updater.
 * Kept free of Electron imports so node:test can exercise the logic.
 */

export const GITHUB_REPO = 'XNYu/Michi';
export const PLACEHOLDER_APP_VERSION = '1.0.0';

export interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface GithubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  prerelease: boolean;
  draft: boolean;
  assets: GithubReleaseAsset[];
}

export interface PickedDmg {
  name: string;
  url: string;
}

export interface UpdateStateFile {
  installedTag?: string | null;
  lastSeenTag?: string | null;
}

export function stripTagPrefix(raw: string): string {
  return raw.trim().replace(/^v/i, '');
}

export function parseSemver(raw: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(stripTagPrefix(raw));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when `latest` is a strictly newer semver than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return stripTagPrefix(latest) !== stripTagPrefix(current);
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] > b[2];
}

export function parseGithubRelease(json: unknown): GithubRelease | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  if (typeof o.tag_name !== 'string' || o.tag_name.trim().length === 0) return null;
  const assetsIn = Array.isArray(o.assets) ? o.assets : [];
  const assets: GithubReleaseAsset[] = [];
  for (const item of assetsIn) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    if (typeof a.name !== 'string' || typeof a.browser_download_url !== 'string') continue;
    assets.push({ name: a.name, browser_download_url: a.browser_download_url });
  }
  return {
    tag_name: o.tag_name,
    name: typeof o.name === 'string' ? o.name : null,
    body: typeof o.body === 'string' ? o.body : null,
    prerelease: o.prerelease === true,
    draft: o.draft === true,
    assets,
  };
}

export function pickMacDmgAsset(assets: GithubReleaseAsset[]): PickedDmg | null {
  const dmgs = assets.filter((a) => /\.dmg$/i.test(a.name));
  const arm = dmgs.find((a) => /arm64|aarch64/i.test(a.name));
  const pick = arm ?? dmgs[0];
  return pick ? { name: pick.name, url: pick.browser_download_url } : null;
}

export function isAllowedDownloadUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return (
      host === 'github.com' ||
      host.endsWith('.github.com') ||
      host === 'githubusercontent.com' ||
      host.endsWith('.githubusercontent.com')
    );
  } catch {
    return false;
  }
}

export function githubLatestReleaseUrl(repo = GITHUB_REPO): string {
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

/**
 * Packaged builds historically shipped with package.json version 1.0.0 even
 * when the GitHub tag was v0.2.x. Prefer an explicit baked/persisted tag.
 */
export function resolveCurrentVersion(input: {
  bakedTag?: string | null;
  persistedTag?: string | null;
  appVersion: string;
}): { version: string; unversioned: boolean } {
  const baked = input.bakedTag?.trim();
  if (baked) return { version: stripTagPrefix(baked), unversioned: false };
  const persisted = input.persistedTag?.trim();
  if (persisted) return { version: stripTagPrefix(persisted), unversioned: false };
  const app = input.appVersion.trim();
  if (app && app !== PLACEHOLDER_APP_VERSION) {
    return { version: stripTagPrefix(app), unversioned: false };
  }
  return { version: stripTagPrefix(app || PLACEHOLDER_APP_VERSION), unversioned: true };
}

/**
 * Decide whether the latest GitHub release should prompt the user.
 * Unversioned (placeholder 1.0.0) builds baseline against lastSeenTag so the
 * first check is silent and later tags still surface.
 */
export function shouldPromptUpdate(input: {
  latestTag: string;
  currentVersion: string;
  unversioned: boolean;
  lastSeenTag?: string | null;
}): boolean {
  const latest = stripTagPrefix(input.latestTag);
  if (!latest) return false;
  if (input.unversioned) {
    const seen = input.lastSeenTag?.trim();
    if (!seen) return false;
    return isNewerVersion(latest, seen);
  }
  return isNewerVersion(latest, input.currentVersion);
}

export function parseUpdateState(json: unknown): UpdateStateFile {
  if (!json || typeof json !== 'object') return {};
  const o = json as Record<string, unknown>;
  return {
    installedTag: typeof o.installedTag === 'string' ? o.installedTag : null,
    lastSeenTag: typeof o.lastSeenTag === 'string' ? o.lastSeenTag : null,
  };
}

/** `…/michi.app/Contents/MacOS/michi` → `…/michi.app` */
export function appBundlePathFromExecPath(execPath: string): string | null {
  const macos = pathDirname(execPath);
  const contents = pathDirname(macos);
  const bundle = pathDirname(contents);
  if (bundle.toLowerCase().endsWith('.app')) return bundle;
  return null;
}

function pathDirname(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (i <= 0) return p;
  return p.slice(0, i);
}
