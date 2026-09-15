import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnAgentProcess, killProcessTree } from '../processTree';
import { withDeadline } from '../runtimeLifecycle';
import { findCodexBinary, preflightCodexAuth, warnIfCodexVersionBelowMinimum } from './codexBinary';
import type { CodexIncoming, CodexRpcId } from './codexProtocol';

export class CodexRpcTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexRpcTimeoutError';
  }
}

export class CodexDaemonExitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexDaemonExitedError';
  }
}

export class CodexRpcError extends Error {
  constructor(readonly method: string, readonly code: number, readonly rpcMessage: string) {
    super(`codex ${method} failed: ${rpcMessage} (code ${code})`);
  }
}

const RPC_TIMEOUT_MS = parseInt(process.env.MICHI_CODEX_RPC_TIMEOUT_MS ?? '30000', 10);
const INIT_TIMEOUT_MS = parseInt(process.env.MICHI_CODEX_INIT_TIMEOUT_MS ?? '30000', 10);

export type NotificationHandler = (method: string, params: Record<string, unknown>) => void;
export type ServerRequestHandler = (
  method: string,
  params: Record<string, unknown>,
  respond: (result: unknown) => void,
) => void;

export interface CodexAppServerClientDeps {
  /** Test seam: returns a ChildProcess-like. Default spawns the real binary. */
  spawnFn?: () => ChildProcessWithoutNullStreams;
  /** Optional isolated environment for the app-server child. */
  spawnEnv?: NodeJS.ProcessEnv;
  rpcTimeoutMs?: number;
  initTimeoutMs?: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
  threadId?: string;
}

/**
 * Singleton owner of the `codex app-server` daemon. JSONL JSON-RPC over
 * stdio. Spawned hermetically with `-c 'mcp_servers={}'` so the user's
 * personal MCP fleet never starts for Michi threads (spec §2); everything
 * else (auth, custom model providers) still loads from ~/.codex, and the
 * child inherits the backend's full process.env (provider env_keys).
 */
export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly threadHandlers = new Map<string, Set<NotificationHandler>>();
  private readonly globalNotificationHandlers = new Set<NotificationHandler>();
  private serverRequestHandler: ServerRequestHandler | null = null;
  private readonly exitHandlers = new Set<() => void>();
  private lineBuf = '';
  private readonly rpcTimeoutMs: number;
  private readonly initTimeoutMs: number;
  private readonly spawnFn: () => ChildProcessWithoutNullStreams;
  private shuttingDown = false;
  private stopping: Promise<void> | null = null;
  private unsafeChild: ChildProcessWithoutNullStreams | null = null;
  private readonly failedSpawns = new WeakSet<ChildProcessWithoutNullStreams>();

  constructor(deps: CodexAppServerClientDeps = {}) {
    this.rpcTimeoutMs = deps.rpcTimeoutMs ?? RPC_TIMEOUT_MS;
    this.initTimeoutMs = deps.initTimeoutMs ?? INIT_TIMEOUT_MS;
    const spawnEnv = deps.spawnEnv ? { ...deps.spawnEnv } : { ...process.env };
    this.spawnFn =
      deps.spawnFn ??
      (() => {
        preflightCodexAuth();
        warnIfCodexVersionBelowMinimum();
        return spawnAgentProcess(findCodexBinary(), ['app-server', '-c', 'mcp_servers={}'], {
          env: spawnEnv,
        });
      });
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  async ensureStarted(timeoutMs = this.initTimeoutMs): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.unsafeChild) throw new Error('Codex process exit is unconfirmed. Original sessions retained; retry after it stops.');
    if (this.starting) return this.starting;
    if (this.child) return;
    this.shuttingDown = false;
    this.starting = this.start(timeoutMs).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(timeoutMs: number): Promise<void> {
    const child = this.spawnFn();
    this.child = child;
    this.lineBuf = '';

    child.stdout.on('data', (chunk: Buffer) => { if (this.child === child) this.onStdout(chunk.toString('utf8')); });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) console.warn('[codex app-server stderr]', text.slice(0, 500));
    });
    child.on('exit', (code) => {
      if (child.pid) killProcessTree(child.pid, 'SIGKILL');
      if (this.unsafeChild === child) this.unsafeChild = null;
      if (this.child === child) this.onExited(code);
    });
    const broken = () => {
      if (this.child !== child) return;
      this.onExited(null);
      void this.stopChild(child).catch(() => {});
    };
    child.stdout.on('end', broken);
    child.stdout.on('close', broken);
    child.stdin.on('error', broken);
    child.stdout.on('error', broken);
    child.stderr.on('error', broken);
    child.on('error', (err) => {
      if (!child.pid) this.failedSpawns.add(child);
      console.error('[CodexAppServerClient] spawn error:', err);
      broken();
    });

    await this.requestWithTimeout(
      'initialize',
      {
        clientInfo: { name: 'michi', title: 'Michi', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      },
      timeoutMs,
    ).catch(async (err) => {
      if (this.child === child) this.onExited(null);
      await this.stopChild(child);
      throw err;
    });

    // Send 'initialized' notification (no id) per protocol handshake
    this.writeLine({ jsonrpc: '2.0', method: 'initialized' });
  }

  private onStdout(text: string): void {
    this.lineBuf += text;
    let nl: number;
    while ((nl = this.lineBuf.indexOf('\n')) >= 0) {
      const line = this.lineBuf.slice(0, nl).trim();
      this.lineBuf = this.lineBuf.slice(nl + 1);
      if (!line) continue;
      let obj: CodexIncoming;
      try {
        obj = JSON.parse(line) as CodexIncoming;
      } catch {
        continue; // tolerate non-JSON noise (e.g. banner lines)
      }
      this.dispatch(obj);
    }
  }

  private dispatch(obj: CodexIncoming): void {
    // Response to one of our requests (numeric ids we minted)
    if (obj.id !== undefined && obj.method === undefined) {
      const entry = typeof obj.id === 'number' ? this.pending.get(obj.id) : undefined;
      if (!entry) return;
      this.pending.delete(obj.id as number);
      clearTimeout(entry.timer);
      if (obj.error) {
        entry.reject(
          new CodexRpcError(entry.method, obj.error.code, obj.error.message),
        );
      } else {
        entry.resolve(obj.result);
      }
      return;
    }

    // Server→client REQUEST (has both id and method) — approval flow
    if (obj.id !== undefined && typeof obj.method === 'string') {
      const rpcId = obj.id as CodexRpcId;
      const child = this.child;
      const respond = (result: unknown) => { if (this.child === child) this.writeLine({ jsonrpc: '2.0', id: rpcId, result }); };
      if (this.serverRequestHandler) {
        this.serverRequestHandler(
          obj.method,
          (obj.params as Record<string, unknown>) ?? {},
          respond,
        );
      } else {
        // No handler registered — fail safe, decline whatever was asked.
        respond({ decision: 'decline' });
      }
      return;
    }

    // Notification (has method, no id)
    if (typeof obj.method === 'string') {
      const params = (obj.params as Record<string, unknown>) ?? {};

      // Global handlers receive every notification — used by CodexSession to
      // discover child subagent threads whose threadId is not yet registered.
      for (const h of this.globalNotificationHandlers) {
        try {
          h(obj.method, params);
        } catch {
          /* global handler must not break dispatch */
        }
      }

      const threadId =
        typeof params['threadId'] === 'string' ? (params['threadId'] as string) : null;
      if (threadId) {
        for (const h of this.threadHandlers.get(threadId) ?? []) h(obj.method, params);
      }
      // Notifications without threadId (account/*, warnings) are intentionally dropped.
    }
  }

  request(method: string, params: unknown, timeoutMs = this.rpcTimeoutMs): Promise<unknown> {
    return this.requestWithTimeout(method, params, timeoutMs);
  }

  hasPendingRequests(ignoredThreads: ReadonlySet<string> = new Set()): boolean {
    return [...this.pending.values()].some((entry) => !entry.threadId || !ignoredThreads.has(entry.threadId));
  }

  private requestWithTimeout(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const child = this.child;
    if (!child) {
      return Promise.reject(
        new CodexDaemonExitedError('codex app-server is not running'),
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CodexRpcTimeoutError(
            `codex ${method} got no response within ${timeoutMs}ms — check provider env vars / daemon stderr`,
          ),
        );
      }, timeoutMs);
      const threadId = (params as { threadId?: string } | null)?.threadId;
      this.pending.set(id, { resolve, reject, timer, method, threadId });
      this.writeLine({ jsonrpc: '2.0', id, method, params });
    });
  }

  private writeLine(obj: unknown): void {
    const child = this.child;
    try {
      child?.stdin.write(JSON.stringify(obj) + '\n', (error) => {
        if (error && this.child === child) {
          this.onExited(null);
          void this.stopChild(child).catch(() => {});
        }
      });
    } catch (err) {
      console.warn('[CodexAppServerClient] stdin write failed:', err);
      if (child && this.child === child) {
        this.onExited(null);
        void this.stopChild(child).catch(() => {});
      }
    }
  }

  onNotification(threadId: string, handler: NotificationHandler): () => void {
    let set = this.threadHandlers.get(threadId);
    if (!set) {
      set = new Set();
      this.threadHandlers.set(threadId, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.threadHandlers.delete(threadId);
    };
  }

  /**
   * Register a handler that receives ALL notifications regardless of threadId.
   * Used by CodexSession to discover child subagent threads (thread/started
   * notifications arrive with the *child* threadId, which has no registered
   * per-thread handler yet).
   */
  onGlobalNotification(handler: NotificationHandler): () => void {
    this.globalNotificationHandlers.add(handler);
    return () => {
      this.globalNotificationHandlers.delete(handler);
    };
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  onExit(cb: () => void): () => void {
    this.exitHandlers.add(cb);
    return () => this.exitHandlers.delete(cb);
  }

  private onExited(code: number | null): void {
    if (!this.child) return;
    this.child = null;
    const err = new CodexDaemonExitedError(
      `codex app-server exited (code ${code ?? 'unknown'})`,
    );
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    if (!this.shuttingDown) {
      for (const cb of this.exitHandlers) {
        try {
          cb();
        } catch (cbErr) {
          console.warn('[CodexAppServerClient] exit handler threw:', cbErr);
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const child = this.child;
    if (!child) { if (this.stopping) await this.stopping; return; }
    this.onExited(null);
    await this.stopChild(child);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new CodexDaemonExitedError('shutdown'));
    }
    this.pending.clear();
  }

  private stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (this.stopping) return this.stopping;
    const signal = (value: NodeJS.Signals) => {
      if (child.pid) killProcessTree(child.pid, value);
      else { try { child.kill(value); } catch { /* failed spawn */ } }
    };
    this.unsafeChild = child;
    const work = (async () => {
      if (this.failedSpawns.has(child) || child.exitCode != null || child.signalCode != null) {
        if (child.pid) signal('SIGKILL');
        this.unsafeChild = null;
        return;
      }
      let exited!: () => void;
      const exit = new Promise<void>((resolve) => { exited = resolve; child.once('exit', resolve); });
      try {
        signal('SIGTERM');
        const stopped = await withDeadline(exit.then(() => true), 2_000, 'exit timeout').catch(() => false);
        signal('SIGKILL');
        if (!stopped) await withDeadline(exit, 2_000, 'Codex process exit could not be confirmed. Original sessions retained.');
        this.unsafeChild = null;
      } finally { child.removeListener('exit', exited); }
    })();
    this.stopping = work;
    void work.finally(() => { if (this.stopping === work) this.stopping = null; }).catch(() => {});
    return work;
  }
}
