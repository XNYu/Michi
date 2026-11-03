import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  SELF_UPDATE_COMMIT_LIMIT,
  type MichiBuildInfo, type SelfUpdateCheck, type SelfUpdateCommit, type SelfUpdateJob, type SelfUpdateStatus,
} from 'michi-shared';

/** The source `michi update` (bin/michi) builds from, unless the machine's environment overrides it. */
const SELF_UPDATE_SOURCE_URL = 'https://github.com/michiworks/Michi.git';
const SELF_UPDATE_SOURCE_REF = 'main';
/** Where a check fetches the branch to, in the running checkout. */
const LATEST_REF = 'refs/michi/self-update/latest';
const EXIT_MARKER = '[michi-self-update exit';
const KEEP_LOGS = 5;
// The environment of a remote backend that must not reach the build:
// NODE_ENV=production makes npm skip the build tools.
const BACKEND_ONLY_ENV = ['MICHI_REMOTE_TOKEN', 'PORT', 'MICHI_BIND_HOST', 'NODE_ENV', 'MICHI_REMOTE_ACCESS',
  'MICHI_REQUIRE_AUTH', 'MICHI_CLOUD', 'INVOCATION_ID', 'JOURNAL_STREAM'];

export class SelfUpdateError extends Error {
  constructor(readonly status: number, message: string, readonly body: Record<string, unknown> = {}) {
    super(message);
  }
}

interface JobRecord {
  id: string;
  from: string | null;
  target: string;
  logFile: string;
  pid: number;
  startedAt: string;
}

export interface SelfUpdateOptions {
  /** The checkout this backend runs from (holds bin/michi). */
  repoRoot: string;
  dataDir: string;
  current: MichiBuildInfo;
  /** Started as a remote backend (MICHI_REMOTE_ACCESS=1). */
  remoteAccess: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  git?: (args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<string>;
  /** Starts the updater outside this process's lifetime; returns its pid. */
  launch?: (command: string, args: string[], logFile: string, env: NodeJS.ProcessEnv) => number;
  /** This process's /proc/self/cgroup. */
  cgroup?: () => string;
  isAlive?: (pid: number) => boolean;
  now?: () => Date;
}

function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, encoding: 'utf8', timeout: 90_000, maxBuffer: 4_000_000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr ?? '') }));
      else resolve(String(stdout));
    });
  });
}

function launchDetached(command: string, args: string[], logFile: string, env: NodeJS.ProcessEnv): number {
  const fd = fs.openSync(logFile, 'a', 0o600);
  try {
    // Its own session: stopping this backend (SIGKILL to its process group)
    // must not stop the update that is replacing it.
    const child = spawn(command, args, { detached: true, env, stdio: ['ignore', fd, fd] });
    if (!child.pid) throw new Error(`Could not start ${command}`);
    child.on('error', () => { /* reported through the log and the missing exit marker */ });
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(fd);
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function readCgroup(): string {
  try { return fs.readFileSync('/proc/self/cgroup', 'utf8'); } catch { return ''; }
}

function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? '').split(path.delimiter).some((dir) => {
    if (!dir) return false;
    try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true; } catch { return false; }
  });
}

function readTail(file: string, bytes = 64_000): string {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - bytes);
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

const stripMark = (line: string) => line.replace(/^(?:✔|✖|🐰|⚠)️?\s*/u, '');

/** The last useful line of git's error output, bounded. */
function gitError(error: unknown): string {
  const stderr = String((error as { stderr?: string }).stderr ?? '').trim().split(/\r?\n/).filter(Boolean).pop();
  return (stderr || (error as Error).message || 'git failed').slice(0, 300);
}

/**
 * Updates the remote backend serving this process to the latest source
 * branch, as `michi update` does in a terminal: build beside the running
 * backend, switch, restart the old build if the new one fails. The updater
 * outlives this process, which it stops; its log and record stay in the data
 * directory so the new backend reports the outcome.
 */
export class SelfUpdater {
  private readonly env: NodeJS.ProcessEnv;
  private readonly git: NonNullable<SelfUpdateOptions['git']>;
  private readonly launch: NonNullable<SelfUpdateOptions['launch']>;
  private readonly isAlive: (pid: number) => boolean;
  private readonly now: () => Date;
  private checking: Promise<SelfUpdateCheck> | null = null;
  private starting = false;

  constructor(private readonly options: SelfUpdateOptions) {
    this.env = options.env ?? process.env;
    this.git = options.git ?? runGit;
    this.launch = options.launch ?? launchDetached;
    this.isAlive = options.isAlive ?? processAlive;
    this.now = options.now ?? (() => new Date());
  }

  private get dir() { return path.join(this.options.dataDir, 'self-update'); }
  private get recordFile() { return path.join(this.dir, 'state.json'); }
  private get source() {
    return { url: this.env.MICHI_REMOTE_SOURCE_URL || SELF_UPDATE_SOURCE_URL, ref: this.env.MICHI_REMOTE_SOURCE_REF || SELF_UPDATE_SOURCE_REF };
  }

  /** Running under the systemd user service, whose stop would end every process in it. */
  private underService(): boolean {
    return /\/michi-remote\.service(?:\/|$)/m.test((this.options.cgroup ?? readCgroup)());
  }

  private unsupported(): string | null {
    const { repoRoot, dataDir, remoteAccess } = this.options;
    if ((this.options.platform ?? process.platform) !== 'linux' || !remoteAccess || !fs.existsSync(path.join(dataDir, 'remote.env'))) {
      return 'Only a remote Linux machine running Michi can update itself from here. Update the desktop app on its computer.';
    }
    if (!fs.existsSync(path.join(repoRoot, 'bin', 'michi')) || !fs.existsSync(path.join(repoRoot, '.git'))) {
      return 'This build cannot update itself. Run michi update on the machine.';
    }
    const { ref } = this.source;
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes('..')) return `The configured source branch ${JSON.stringify(ref)} is not valid.`;
    if (this.underService() && !onPath('systemd-run', this.env)) {
      return 'This machine runs Michi as a systemd service without systemd-run. Run michi update on the machine.';
    }
    return null;
  }

  status(): SelfUpdateStatus {
    const reason = this.unsupported();
    return {
      supported: !reason,
      ...(reason ? { reason } : {}),
      branch: this.source.ref,
      current: this.options.current,
      job: this.readJob(),
    };
  }

  /** Fetches the branch and lists what an update would bring in. One check runs at a time. */
  check(): Promise<SelfUpdateCheck> {
    this.checking ??= this.runCheck().finally(() => { this.checking = null; });
    return this.checking;
  }

  private async runCheck(): Promise<SelfUpdateCheck> {
    const status = this.status();
    if (!status.supported) throw new SelfUpdateError(409, status.reason!, { status });
    const { repoRoot } = this.options;
    const { url, ref } = this.source;
    const env = { ...this.env, GIT_TERMINAL_PROMPT: '0' };
    const git = (...args: string[]) => this.git(args, repoRoot, env);
    try {
      await git('fetch', '--quiet', '--no-tags', '--', url, `+refs/heads/${ref}:${LATEST_REF}`);
    } catch (error) {
      throw new SelfUpdateError(502, `Could not read ${ref} from ${url}: ${gitError(error)}. Check this machine's network connection and repository credentials, then try again.`, { status });
    }
    const latest = (await git('rev-parse', '--verify', `${LATEST_REF}^{commit}`)).trim();
    const current = status.current.revision;
    const known = !!current && await git('cat-file', '-e', `${current}^{commit}`).then(() => true, () => false);
    // Equal, or a newer build than the branch (it was rewound): nothing to update.
    const contained = known && (latest === current || await git('merge-base', '--is-ancestor', latest, current!).then(() => true, () => false));
    let commits: SelfUpdateCommit[] = [];
    let total = 0;
    if (!contained) {
      const range = known ? [`${current}..${latest}`] : ['-1', latest];
      commits = (await git('log', `--max-count=${SELF_UPDATE_COMMIT_LIMIT}`, '--format=%H%x1f%s%x1f%cI', ...range, '--'))
        .split('\n').filter(Boolean).map((line) => {
          const [revision, subject, date] = line.split('\x1f');
          return { revision, subject, date };
        });
      total = known ? Number((await git('rev-list', '--count', `${current}..${latest}`, '--')).trim()) || commits.length : commits.length;
    }
    let blocked: string | undefined;
    if (!contained) {
      const changes = await git('status', '--porcelain', '--untracked-files=normal', '--', '.', ':!package-lock.json').catch(() => '');
      if (changes.trim()) blocked = `This machine's Michi checkout (${repoRoot}) has local changes that updating would not keep. Run michi update --force on the machine to update anyway.`;
    }
    return {
      ...status, state: contained ? 'current' : 'available', latest, commits, total,
      ...(blocked ? { blocked } : {}), checkedAt: this.now().toISOString(),
    };
  }

  /**
   * Starts `michi update` when the branch still names `expected` (the
   * revision the user confirmed). Resolves once the updater has started; its
   * progress is read from status().
   */
  async start(expected?: string): Promise<SelfUpdateJob> {
    const running = this.readJob();
    if (this.starting || running?.phase === 'running') {
      throw new SelfUpdateError(409, 'An update is already running.', { code: 'running', job: running });
    }
    this.starting = true;
    try {
      const check = await this.check();
      if (expected && check.latest !== expected) {
        throw new SelfUpdateError(409, `${check.branch} changed since the last check. Review the new commits, then update again.`, { code: 'moved', check });
      }
      if (check.state === 'current') throw new SelfUpdateError(409, 'Michi is already up to date.', { code: 'current', check });
      if (check.blocked) throw new SelfUpdateError(409, check.blocked, { code: 'blocked', check });

      const { repoRoot, dataDir } = this.options;
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      this.pruneLogs();
      const id = randomUUID();
      const logFile = path.join(this.dir, `${id}.log`);
      fs.writeFileSync(logFile, '', { mode: 0o600 });
      const env: NodeJS.ProcessEnv = { ...this.env, MICHI_DATA_DIR: dataDir };
      for (const key of BACKEND_ONLY_ENV) delete env[key];
      // The wrapper records michi's exit status, which the next backend reads.
      const update = ['bash', '-c', `"$@"; echo "${EXIT_MARKER} $?]"`, 'michi-self-update',
        'bash', path.join(repoRoot, 'bin', 'michi'), 'update', '--data-dir', dataDir];
      // `systemctl stop` ends every process of the service; a scope of its own survives that.
      const [command, ...args] = this.underService()
        ? ['systemd-run', '--user', '--scope', '--quiet', `--unit=michi-self-update-${id.slice(0, 8)}`, ...update]
        : update;
      const pid = this.launch(command, args, logFile, env);
      const record: JobRecord = { id, from: check.current.revision, target: check.latest, logFile, pid, startedAt: this.now().toISOString() };
      const temporary = `${this.recordFile}.tmp-${process.pid}`;
      fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, this.recordFile);
      return this.readJob()!;
    } finally {
      this.starting = false;
    }
  }

  private pruneLogs(): void {
    try {
      const logs = fs.readdirSync(this.dir).filter((name) => name.endsWith('.log'))
        .map((name) => ({ name, time: fs.statSync(path.join(this.dir, name)).mtimeMs }))
        .sort((a, b) => b.time - a.time);
      for (const old of logs.slice(KEEP_LOGS - 1)) fs.rmSync(path.join(this.dir, old.name), { force: true });
    } catch { /* best effort */ }
  }

  private readJob(): SelfUpdateJob | null {
    let record: JobRecord;
    try {
      record = JSON.parse(fs.readFileSync(this.recordFile, 'utf8'));
      if (typeof record?.id !== 'string' || typeof record.logFile !== 'string' || !Number.isInteger(record.pid)) return null;
    } catch { return null; }
    const lines = readTail(record.logFile).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const exit = [...lines].reverse().map((line) => /^\[michi-self-update exit (\d+)\]$/.exec(line)).find(Boolean);
    const marked = lines.filter((line) => /^(?:✔|✖|🐰)/u.test(line));
    const progress = marked.at(-1);
    const failure = [...marked].reverse().find((line) => line.startsWith('✖'));
    const switching = lines.some((line) => line.includes('Switching to the new build'));
    const base = { id: record.id, from: record.from, target: record.target, startedAt: record.startedAt, logFile: record.logFile };
    const finishedAt = () => {
      try { return fs.statSync(record.logFile).mtime.toISOString(); } catch { return undefined; }
    };
    if (exit) {
      const ok = exit[1] === '0';
      return {
        ...base, phase: ok ? 'succeeded' : 'failed', stage: ok ? 'done' : switching ? 'switching' : 'building',
        message: ok ? stripMark(progress ?? '✔ Michi is up to date')
          : failure ? stripMark(failure) : `michi update exited with status ${exit[1]}.`,
        finishedAt: finishedAt(),
      };
    }
    if (this.isAlive(record.pid)) {
      return { ...base, phase: 'running', stage: switching ? 'switching' : 'building', message: progress ? stripMark(progress) : 'Starting the update' };
    }
    const revision = this.options.current.revision;
    if (revision && revision === record.target) {
      return { ...base, phase: 'succeeded', stage: 'done', message: `Michi updated to ${revision.slice(0, 8)}`, finishedAt: finishedAt() };
    }
    return {
      ...base, phase: 'failed', stage: switching ? 'switching' : 'building',
      message: failure ? stripMark(failure) : 'The update stopped before it finished.', finishedAt: finishedAt(),
    };
  }
}
