import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactRemoteLog, type RemoteConnectionDiagnostic } from 'michi-shared';
import { log } from './logger';

const LIMIT = 4 * 1024 * 1024;
const active = new Map<string, RemoteDiagnosticLog>();
const directory = () => path.join(log.logDir(), 'remote-connections');

export { redactRemoteLog } from 'michi-shared';

export class RemoteDiagnosticLog {
  readonly report: RemoteConnectionDiagnostic;
  private secrets: string[] = [];
  private saveTimer?: ReturnType<typeof setTimeout>;
  private finished = false;
  constructor(host: string) {
    this.report = { id: randomUUID(), host: redactRemoteLog(host), startedAt: new Date().toISOString(), stage: 'ssh', severity: 'info', message: 'Connecting over SSH…', log: '', truncated: false };
    this.report.localLogPath = path.join(directory(), this.report.id + '.json');
    active.set(this.report.id, this);
    try {
      fs.mkdirSync(directory(), { recursive: true, mode: 0o700 });
      const files = fs.readdirSync(directory()).filter(name => /^[\da-f-]{36}\.json$/.test(name))
        .map(name => ({ name, time: fs.statSync(path.join(directory(), name)).mtimeMs }))
        .sort((a, b) => b.time - a.time);
      for (const file of files.slice(19)) {
        if (!active.has(file.name.slice(0, -5))) fs.unlinkSync(path.join(directory(), file.name));
      }
    } catch { this.report.storageError = 'Local log could not be saved. Keep a copy of this diagnostic.'; }
    this.append('attempt', 'Connection requested');
  }
  private clean(value: string): string {
    for (const secret of this.secrets) value = value.split(secret).join('[redacted]');
    return redactRemoteLog(value);
  }
  protect(secret?: string): void { if (secret) this.secrets.push(secret); }
  append(source: string, value: string): void {
    if (this.finished) return;
    const entry = new Date().toISOString() + ' [' + source + '] ' + this.clean(value) + '\n';
    const remaining = LIMIT - this.report.log.length;
    if (entry.length > remaining) this.report.truncated = true;
    this.report.log += entry.slice(0, Math.max(0, remaining));
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => { this.saveTimer = undefined; this.save(); }, 250);
      this.saveTimer.unref();
    }
  }
  stage(stage: string, message: string): void {
    if (this.finished) return;
    this.report.stage = stage; this.report.message = this.clean(message);
    this.append(stage, message); this.save();
  }
  fail(error: unknown, code: string): void {
    if (this.finished) return;
    this.report.severity = 'error';
    this.report.code = code;
    this.report.message = this.clean(error instanceof Error ? error.message : String(error));
    this.append('error', error instanceof Error ? error.stack ?? error.message : String(error));
    if (error instanceof Error && error.cause) this.append('cause', String(error.cause));
  }
  warn(messages: string[]): string[] {
    const warnings = messages.map(message => this.clean(message));
    if (this.finished) return warnings;
    this.report.stage = 'runtime';
    this.report.severity = 'warning';
    this.report.code = 'runtime_warning';
    this.report.message = warnings.join(' ');
    for (const warning of warnings) this.append('runtime warning', warning);
    return warnings;
  }
  save(): void {
    try { fs.writeFileSync(path.join(directory(), this.report.id + '.json'), JSON.stringify(this.report), { mode: 0o600 }); }
    catch { this.report.storageError = 'Local log could not be saved. Keep a copy of this diagnostic.'; }
  }
  finish(): void { clearTimeout(this.saveTimer); this.saveTimer = undefined; this.save(); this.finished = true; active.delete(this.report.id); }
}

export function readRemoteDiagnostic(id: string): RemoteConnectionDiagnostic | null {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(id)) return null;
  const live = active.get(id); if (live) return live.report;
  try { return JSON.parse(fs.readFileSync(path.join(directory(), id + '.json'), 'utf8')); }
  catch { return null; }
}
