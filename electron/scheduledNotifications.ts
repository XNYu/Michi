/**
 * Electron-main client for the backend's scheduled job notification stream.
 * Kept free of `electron` imports so the SSE handling is testable in Node.
 */
import * as http from 'node:http';

/** Mirror of shared ScheduledJobRunEvent; Electron main does not load workspace packages. */
export interface ScheduledRunNotice {
  phase: 'started' | 'finished' | 'attention';
  runId: string;
  jobId: string;
  jobName: string;
  workspaceId: string;
  nodeId: string | null;
  treeId: string | null;
  status: string;
  summary: string | null;
  error: string | null;
  notify: boolean;
  attention?: 'approval' | 'input';
  at: number;
}

export const SCHEDULED_JOB_RUN_EVENT = 'scheduled_job_run';

export function isScheduledRunNotice(value: unknown): value is ScheduledRunNotice {
  if (!value || typeof value !== 'object') return false;
  const notice = value as Record<string, unknown>;
  return (notice.phase === 'started' || notice.phase === 'finished' || notice.phase === 'attention')
    && typeof notice.runId === 'string'
    && typeof notice.jobId === 'string'
    && typeof notice.jobName === 'string'
    && typeof notice.workspaceId === 'string'
    && (notice.nodeId === null || typeof notice.nodeId === 'string')
    && typeof notice.status === 'string';
}

/** Incremental SSE parser: feed text chunks, receive complete events. */
export function createSseParser(onEvent: (event: string, data: string) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length > 0) onEvent(event, data.join('\n'));
      boundary = buffer.indexOf('\n\n');
    }
    // Defend against a peer that never terminates a frame.
    if (buffer.length > 1_000_000) buffer = '';
  };
}

/** What a notice should say. Returns null for notices that are not shown. */
export function describeNotice(notice: ScheduledRunNotice): { title: string; subtitle: string; body: string } | null {
  if (notice.phase === 'attention') {
    return {
      title: notice.jobName,
      subtitle: notice.attention === 'input' ? 'Needs your input' : 'Needs your approval',
      body: 'The scheduled run is waiting. Open it in Michi to continue.',
    };
  }
  if (notice.phase !== 'finished' || !notice.notify) return null;
  if (notice.status === 'succeeded') {
    return { title: notice.jobName, subtitle: 'Scheduled job finished', body: notice.summary || 'Open Michi to see the result.' };
  }
  if (notice.status === 'failed' || notice.status === 'timed_out') {
    return { title: notice.jobName, subtitle: 'Scheduled job failed', body: notice.error || 'Open Michi for details.' };
  }
  return null;
}

export interface NotificationFeedOptions {
  /** Current backend port; null pauses the feed. */
  port(): number | null;
  onNotice(notice: ScheduledRunNotice): void;
  log?(level: 'INFO' | 'WARN', message: string, meta?: Record<string, unknown>): void;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

/** Long-lived, self-reconnecting subscription to /api/scheduled-jobs/notifications/stream. */
export class ScheduledNotificationFeed {
  private request: http.ClientRequest | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = true;

  constructor(private readonly options: NotificationFeedOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.request?.destroy();
    this.request = null;
  }

  /** Drop the current connection and reconnect now (e.g. after a backend handoff). */
  restart(): void {
    this.stop();
    this.attempt = 0;
    this.start();
  }

  acknowledge(runId: string): void {
    const port = this.options.port();
    if (!port) return;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method: 'POST',
      path: `/api/scheduled-jobs/runs/${encodeURIComponent(runId)}/notified`,
      timeout: 5_000,
    }, (res) => res.resume());
    req.on('timeout', () => req.destroy());
    req.on('error', () => { /* replayed on the next connection */ });
    req.end();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const base = this.options.reconnectBaseMs ?? 1_000;
    const max = this.options.reconnectMaxMs ?? 15_000;
    const delay = Math.min(max, base * 2 ** this.attempt);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
    this.timer.unref?.();
  }

  private connect(): void {
    if (this.stopped) return;
    const port = this.options.port();
    if (!port) {
      this.scheduleReconnect();
      return;
    }
    const parse = createSseParser((event, data) => {
      if (event !== SCHEDULED_JOB_RUN_EVENT) return;
      try {
        const notice = JSON.parse(data) as unknown;
        if (isScheduledRunNotice(notice)) this.options.onNotice(notice);
      } catch {
        // Ignore malformed frames.
      }
    });
    const req = http.get({
      hostname: '127.0.0.1',
      port,
      path: '/api/scheduled-jobs/notifications/stream',
      headers: { accept: 'text/event-stream' },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        // 404: scheduling is off on this backend; retry slowly in case it restarts.
        this.options.log?.('WARN', 'scheduled notification feed rejected', { status: res.statusCode });
        return;
      }
      this.attempt = 0;
      this.options.log?.('INFO', 'scheduled notification feed connected', { port });
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => parse(chunk));
    });
    req.on('close', () => {
      // A request replaced by restart() or ended by stop() must not reconnect.
      if (this.request !== req) return;
      this.request = null;
      this.scheduleReconnect();
    });
    req.on('error', () => { /* close follows */ });
    this.request = req;
  }
}
