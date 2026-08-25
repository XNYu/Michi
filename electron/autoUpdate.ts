import { app, BrowserWindow, ipcMain, Notification as ElectronNotification } from 'electron';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import {
  GITHUB_REPO,
  appBundlePathFromExecPath,
  githubLatestReleaseUrl,
  isAllowedDownloadUrl,
  parseGithubRelease,
  parseUpdateState,
  pickMacDmgAsset,
  resolveCurrentVersion,
  shouldPromptUpdate,
  stripTagPrefix,
  type GithubRelease,
  type UpdateStateFile,
} from './updateRelease';

const execFileAsync = promisify(execFile);

export type AppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'unavailable'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error';

export interface AppUpdateState {
  status: AppUpdateStatus;
  currentVersion: string;
  latestVersion?: string;
  notes?: string;
  percent?: number;
  error?: string;
}

type SendToWindows = (channel: string, payload: AppUpdateState) => void;

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 8_000;
const FETCH_TIMEOUT_MS = 15_000;

let sendToWindows: SendToWindows = () => undefined;
let checkTimer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;
let downloadedDmg: string | null = null;
let downloadedTag: string | null = null;

const state: AppUpdateState = {
  status: 'idle',
  currentVersion: '',
};

function elog(level: 'INFO' | 'WARN' | 'ERROR', msg: string, meta?: Record<string, unknown>): void {
  const extra = meta ? ` ${JSON.stringify(meta)}` : '';
  const line = `[autoUpdate] ${level} ${msg}${extra}\n`;
  if (level === 'ERROR') process.stderr.write(line);
  else process.stdout.write(line);
}

function emit(): void {
  sendToWindows('app:update-state', { ...state });
}

function setState(patch: Partial<AppUpdateState>): void {
  Object.assign(state, patch);
  emit();
}

function updateStateFile(): string {
  return path.join(app.getPath('userData'), 'update-state.json');
}

function readPersisted(): UpdateStateFile {
  try {
    return parseUpdateState(JSON.parse(fs.readFileSync(updateStateFile(), 'utf8')));
  } catch {
    return {};
  }
}

function writePersisted(next: UpdateStateFile): void {
  try {
    const merged = { ...readPersisted(), ...next };
    fs.mkdirSync(path.dirname(updateStateFile()), { recursive: true });
    fs.writeFileSync(updateStateFile(), JSON.stringify(merged));
  } catch {
    /* best effort */
  }
}

function readBakedTag(): string | null {
  const env = process.env.MICHI_RELEASE_TAG?.trim();
  if (env) return env;
  const candidates = [
    path.join(__dirname, 'releaseInfo.json'),
    path.join(__dirname, '..', 'releaseInfo.json'),
  ];
  for (const file of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { tag?: unknown };
      if (typeof raw.tag === 'string' && raw.tag.trim()) return raw.tag.trim();
    } catch {
      /* try next */
    }
  }
  return null;
}

function currentVersionInfo(): { version: string; unversioned: boolean } {
  const persisted = readPersisted();
  return resolveCurrentVersion({
    bakedTag: readBakedTag(),
    persistedTag: persisted.installedTag,
    appVersion: app.getVersion(),
  });
}

function repoSlug(): string {
  return process.env.MICHI_UPDATE_REPO?.trim() || GITHUB_REPO;
}

async function fetchLatestRelease(): Promise<GithubRelease> {
  const url = githubLatestReleaseUrl(repoSlug());
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'michi-updater',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`GitHub releases HTTP ${res.status}`);
    const parsed = parseGithubRelease(await res.json());
    if (!parsed || parsed.draft) throw new Error('No published GitHub release');
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

async function runCheck(): Promise<void> {
  if (state.status === 'downloading' || state.status === 'installing') return;
  const current = currentVersionInfo();
  state.currentVersion = current.version;
  const alreadyPrompting = state.status === 'available' || state.status === 'ready';
  setState({ status: 'checking', error: undefined });
  try {
    const latest = await fetchLatestRelease();
    const dmg = pickMacDmgAsset(latest.assets);
    const persisted = readPersisted();
    const prompt = shouldPromptUpdate({
      latestTag: latest.tag_name,
      currentVersion: current.version,
      unversioned: current.unversioned,
      lastSeenTag: persisted.lastSeenTag,
    });
    if (!persisted.lastSeenTag) writePersisted({ lastSeenTag: latest.tag_name });
    if (!dmg) {
      setState({
        status: 'unavailable',
        latestVersion: stripTagPrefix(latest.tag_name),
        notes: latest.body ?? undefined,
      });
      return;
    }
    if (prompt) {
      const latestVersion = stripTagPrefix(latest.tag_name);
      const alreadyReady = downloadedTag === latest.tag_name && downloadedDmg && fs.existsSync(downloadedDmg);
      setState({
        status: alreadyReady ? 'ready' : 'available',
        latestVersion,
        notes: latest.body ?? undefined,
        percent: alreadyReady ? 100 : undefined,
      });
      if (!alreadyReady && !alreadyPrompting) notifyAvailable(latestVersion);
    } else {
      setState({
        status: 'unavailable',
        latestVersion: stripTagPrefix(latest.tag_name),
        notes: latest.body ?? undefined,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    elog('WARN', 'check failed', { error: message });
    setState({ status: 'error', error: message });
  }
}

function notifyAvailable(version: string): void {
  try {
    const n = new ElectronNotification({
      title: 'Michi update available',
      body: `Version ${version} is ready to download.`,
    });
    n.on('click', () => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      win?.show();
      win?.focus();
    });
    n.show();
  } catch {
    /* notifications are optional */
  }
}

function downloadToFile(url: string, dest: string, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (target: string, hops: number) => {
      if (hops > 5) {
        reject(new Error('Too many redirects'));
        return;
      }
      if (!isAllowedDownloadUrl(target)) {
        reject(new Error('Unexpected download host'));
        return;
      }
      const lib = target.startsWith('https:') ? https : http;
      const req = lib.get(target, { headers: { 'User-Agent': 'michi-updater' } }, (res) => {
        const loc = res.headers.location;
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc) {
          res.resume();
          const next = new URL(loc, target).toString();
          follow(next, hops + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Download failed (${res.statusCode})`));
          return;
        }
        const total = Number(res.headers['content-length'] || 0);
        let received = 0;
        let lastEmit = 0;
        const file = fs.createWriteStream(dest);
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (total > 0) {
            const percent = Math.min(100, Math.round((received / total) * 100));
            if (percent !== lastEmit && (percent === 100 || percent - lastEmit >= 2)) {
              lastEmit = percent;
              onProgress(percent);
            }
          }
        });
        res.pipe(file);
        file.on('finish', () => file.close((err) => (err ? reject(err) : resolve())));
        file.on('error', reject);
        res.on('error', reject);
      });
      req.on('error', reject);
    };
    follow(url, 0);
  });
}

async function runDownload(): Promise<void> {
  if (state.status === 'downloading' || state.status === 'installing') return;
  if (state.status === 'ready' && downloadedDmg && fs.existsSync(downloadedDmg)) return;
  setState({ status: 'downloading', percent: 0, error: undefined });
  try {
    const latest = await fetchLatestRelease();
    const dmg = pickMacDmgAsset(latest.assets);
    if (!dmg) throw new Error('Latest release has no macOS DMG');
    if (!isAllowedDownloadUrl(dmg.url)) throw new Error('Unexpected download host');
    const dir = path.join(app.getPath('temp'), 'michi-updates');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, dmg.name);
    await downloadToFile(dmg.url, dest, (percent) => {
      setState({ status: 'downloading', percent, latestVersion: stripTagPrefix(latest.tag_name) });
    });
    downloadedDmg = dest;
    downloadedTag = latest.tag_name;
    setState({
      status: 'ready',
      percent: 100,
      latestVersion: stripTagPrefix(latest.tag_name),
      notes: latest.body ?? undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    elog('ERROR', 'download failed', { error: message });
    setState({ status: 'error', error: message });
  }
}

async function applyDownloadedUpdate(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('Auto-install is only supported on macOS');
  }
  if (!downloadedDmg || !fs.existsSync(downloadedDmg)) {
    throw new Error('Update has not been downloaded yet');
  }
  const bundle = appBundlePathFromExecPath(process.execPath);
  if (!bundle) throw new Error('Could not locate the running michi.app bundle');
  try {
    fs.accessSync(bundle, fs.constants.W_OK);
  } catch {
    throw new Error(`Cannot replace ${bundle}. Move Michi to your Applications folder and try again.`);
  }

  setState({ status: 'installing', percent: 100, error: undefined });

  const mountPoint = path.join(os.tmpdir(), `michi-update-mnt-${Date.now()}`);
  const staged = path.join(os.tmpdir(), `michi-update-${state.latestVersion ?? 'next'}.app`);
  try {
    await execFileAsync('xattr', ['-dr', 'com.apple.quarantine', downloadedDmg]).catch(() => undefined);
    await fs.promises.mkdir(mountPoint, { recursive: true });
    await execFileAsync('hdiutil', ['attach', downloadedDmg, '-nobrowse', '-readonly', '-mountpoint', mountPoint]);
    const entries = await fs.promises.readdir(mountPoint);
    const appName = entries.find((name) => name.endsWith('.app'));
    if (!appName) throw new Error('Mounted DMG does not contain michi.app');
    await fs.promises.rm(staged, { recursive: true, force: true });
    await execFileAsync('ditto', [path.join(mountPoint, appName), staged]);
  } catch (err) {
    try { await execFileAsync('hdiutil', ['detach', mountPoint, '-quiet', '-force']); } catch { /* */ }
    const message = err instanceof Error ? err.message : String(err);
    setState({
      status: downloadedDmg && fs.existsSync(downloadedDmg) ? 'ready' : 'error',
      error: message,
      latestVersion: state.latestVersion,
    });
    throw err;
  }
  try { await execFileAsync('hdiutil', ['detach', mountPoint, '-quiet', '-force']); } catch { /* */ }
  try { await fs.promises.rmdir(mountPoint); } catch { /* */ }

  const scriptPath = path.join(os.tmpdir(), `michi-apply-update-${Date.now()}.sh`);
  const script = `#!/bin/bash
set -euo pipefail
APP="$1"
NEW="$2"
PID="$3"
for _ in $(seq 1 80); do
  if ! kill -0 "$PID" 2>/dev/null; then
    break
  fi
  sleep 0.2
done
sleep 0.4
rm -rf "$APP"
ditto "$NEW" "$APP"
xattr -dr com.apple.quarantine "$APP" || true
open -n "$APP"
rm -rf "$NEW"
rm -f "$0"
`;
  await fs.promises.writeFile(scriptPath, script, { mode: 0o755 });
  if (downloadedTag) writePersisted({ installedTag: downloadedTag, lastSeenTag: downloadedTag });
  const child = spawn('/bin/bash', [scriptPath, bundle, staged, String(process.pid)], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  elog('INFO', 'apply script launched', { bundle, staged });
  app.quit();
}

function enqueue(job: () => Promise<void>): Promise<void> {
  const run = (inFlight ?? Promise.resolve()).then(job, job);
  inFlight = run.catch(() => undefined);
  return run;
}

export function getUpdateState(): AppUpdateState {
  if (!state.currentVersion) state.currentVersion = currentVersionInfo().version;
  return { ...state };
}

export function checkForUpdate(): Promise<void> {
  return enqueue(runCheck);
}

export function downloadUpdate(): Promise<void> {
  return enqueue(runDownload);
}

export async function installUpdate(): Promise<void> {
  await enqueue(applyDownloadedUpdate);
}

export function initAutoUpdate(opts: {
  isDev: boolean;
  isPackaged: boolean;
  sendToWindows: SendToWindows;
}): void {
  sendToWindows = opts.sendToWindows;
  state.currentVersion = currentVersionInfo().version;

  ipcMain.handle('app:getUpdateState', () => getUpdateState());
  ipcMain.handle('app:checkForUpdate', async () => {
    await checkForUpdate();
    return getUpdateState();
  });
  ipcMain.handle('app:downloadUpdate', async () => {
    await downloadUpdate();
    return getUpdateState();
  });
  ipcMain.handle('app:installUpdate', async () => {
    await installUpdate();
    return getUpdateState();
  });

  if (opts.isDev || !opts.isPackaged) {
    elog('INFO', 'disabled in unpackaged/dev session');
    return;
  }
  if (process.platform !== 'darwin') {
    elog('INFO', 'disabled on non-macOS');
    return;
  }

  const start = () => {
    void checkForUpdate();
    checkTimer = setInterval(() => { void checkForUpdate(); }, CHECK_INTERVAL_MS);
    checkTimer.unref();
  };
  setTimeout(start, STARTUP_DELAY_MS).unref();
}

export function stopAutoUpdate(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}
