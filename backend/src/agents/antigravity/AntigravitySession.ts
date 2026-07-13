import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { AgentSession, ChatMessage } from "../types";
import type { NormalizedEvent } from "../../services/chatEvents";
import { EventQueue } from "../eventQueue";
import { followUpReminder } from "../preamble";

const DEFAULT_PRINT_TIMEOUT_MS = (() => {
  const raw = process.env.ANTIGRAVITY_TIMEOUT_MS ?? process.env.ACP_TIMEOUT_MS;
  if (!raw) return 300_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300_000;
})();

const CONVERSATION_ID_RE = /Created conversation ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

export class AntigravityCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AntigravityCliError";
  }
}

export interface AntigravitySessionOptions {
  nodeId: string;
  cwd: string;
  binaryPath: string;
  logDir: string;
  parentChatId?: string;
  model?: string | null;
  mode?: string | null;
  externalConversationId?: string | null;
  firstTurnPrefix?: string;
  enableFollowUps?: boolean;
  customizationDir?: string;
  agentName?: string;
  onConversationId?: (conversationId: string) => void;
}

/**
 * Process-per-turn adapter for `agy --print`. Antigravity has no public ACP or
 * app-server entrypoint, so stdout is the only supported incremental stream.
 * A unique `--log-file` gives us the server-created conversation UUID without
 * racing the CLI's cwd-keyed last_conversations.json cache.
 */
export class AntigravitySession implements AgentSession {
  public readonly runtimeId = "antigravity";
  public readonly id: string;
  public readonly parentChatId?: string;

  private readonly cwd: string;
  private readonly binaryPath: string;
  private readonly logDir: string;
  private readonly onConversationId?: (conversationId: string) => void;
  private readonly enableFollowUps: boolean;
  private readonly customizationDir?: string;
  private readonly agentName?: string;
  private readonly history: ChatMessage[] = [];
  private firstTurnPrefix: string;
  private externalConversationId: string | null;
  private model: string | null;
  private mode: string | null;
  private activeChild: ChildProcessWithoutNullStreams | null = null;
  private activeCancelled = false;
  private pendingAssistant: string[] | null = null;

  constructor(opts: AntigravitySessionOptions) {
    this.id = opts.nodeId;
    this.parentChatId = opts.parentChatId;
    this.cwd = opts.cwd;
    this.binaryPath = opts.binaryPath;
    this.logDir = opts.logDir;
    this.onConversationId = opts.onConversationId;
    this.enableFollowUps = opts.enableFollowUps !== false;
    this.customizationDir = opts.customizationDir;
    this.agentName = opts.agentName;
    this.firstTurnPrefix = opts.firstTurnPrefix ?? "";
    this.externalConversationId = opts.externalConversationId ?? null;
    this.model = opts.model ?? null;
    this.mode = opts.mode ?? null;
  }

  get currentModeId(): string | null {
    return this.mode;
  }

  get currentModelId(): string | null {
    return this.model;
  }

  getHistory(): ChatMessage[] {
    return this.history;
  }

  getPendingAssistant(): string | undefined {
    return this.pendingAssistant?.join("");
  }

  getExternalConversationId(): string | null {
    return this.externalConversationId;
  }

  async *send(text: string): AsyncIterableIterator<NormalizedEvent> {
    if (this.activeChild) throw new AntigravityCliError("Antigravity session already has a turn in flight");

    this.history.push({ role: "user", content: text });
    const userTurnCount = this.history.filter((message) => message.role === "user").length;
    const reminder = followUpReminder(userTurnCount, this.enableFollowUps);
    let prompt = reminder ? `${text}${reminder}` : text;
    if (this.firstTurnPrefix) {
      prompt = `${this.firstTurnPrefix}\n${prompt}`;
      this.firstTurnPrefix = "";
    }

    fs.mkdirSync(this.logDir, { recursive: true });
    const logPath = path.join(this.logDir, `turn-${this.id}-${randomUUID()}.log`);
    const args = [
      "--log-file", logPath,
      `--print-timeout=${Math.max(1, Math.ceil(DEFAULT_PRINT_TIMEOUT_MS / 1000))}s`,
      "--add-dir", this.cwd,
    ];
    if (this.customizationDir) args.push("--add-dir", this.customizationDir);
    // AGY ignores --agent when resuming an existing conversation. Avoid the
    // warning; the original conversation already captured its agent profile.
    if (this.agentName && !this.externalConversationId) args.push("--agent", this.agentName);
    if (this.model) args.push("--model", this.model);
    if (this.mode === "sandbox") args.push("--sandbox");
    else if (this.mode && this.mode !== "default") args.push("--mode", this.mode);
    if (this.externalConversationId) args.push("--conversation", this.externalConversationId);
    args.push("--print", prompt);

    const queue = new EventQueue((idleMs) => queue.push({ kind: "heartbeat", idleMs }));
    const assistantChunks: string[] = [];
    this.pendingAssistant = assistantChunks;
    this.activeCancelled = false;
    const startedAt = Date.now();
    let failure: Error | null = null;
    let finalized = false;

    const child = spawn(this.binaryPath, args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.activeChild = child;
    const stderr: string[] = [];
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    const pushStdout = (value: string): void => {
      if (!value) return;
      assistantChunks.push(value);
      queue.push({ kind: "chunk", text: value });
    };

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (finalized) return;
      finalized = true;
      pushStdout(stdoutDecoder.end());
      const trailingError = stderrDecoder.end();
      if (trailingError) stderr.push(trailingError);
      const cancelled = this.activeCancelled;
      try {
        if (!this.externalConversationId) {
          const discovered = readConversationId(logPath);
          if (discovered) {
            this.externalConversationId = discovered;
            this.onConversationId?.(discovered);
          }
        }
      } catch {
        // A successful answer remains usable even if log cleanup/parsing fails.
      }
      try { fs.rmSync(logPath, { force: true }); } catch {}

      if (cancelled) {
        queue.push({ kind: "usage_summary", contextUsagePercentage: 0, totalCredits: 0, turnDurationMs: Date.now() - startedAt });
        queue.push({ kind: "turn_end", stopReason: "cancelled" });
        return;
      }
      if (code === 0) {
        if (!this.externalConversationId) {
          failure = new AntigravityCliError("agy completed but did not expose a conversation id");
          queue.push(null);
          return;
        }
        queue.push({ kind: "usage_summary", contextUsagePercentage: 0, totalCredits: 0, turnDurationMs: Date.now() - startedAt });
        queue.push({ kind: "turn_end", stopReason: "end_turn" });
        return;
      }
      const detail = stderr.join("").trim();
      failure = new AntigravityCliError(
        detail || `agy exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`,
      );
      queue.push(null);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      pushStdout(stdoutDecoder.write(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const value = stderrDecoder.write(chunk);
      if (value) stderr.push(value);
    });
    child.on("error", (err) => {
      failure = err;
      if (!finalized) {
        finalized = true;
        queue.push(null);
      }
    });
    // `close` fires after stdout/stderr close, so decoder.end() can safely
    // flush a final partial UTF-8 code point before turn_end.
    child.on("close", finish);

    try {
      while (true) {
        const event = await queue.pull();
        if (event === null) {
          if (failure) throw failure;
          return;
        }
        yield event;
        if (event.kind === "turn_end") return;
      }
    } finally {
      queue.dispose();
      if (assistantChunks.length > 0) {
        this.history.push({ role: "assistant", content: assistantChunks.join("") });
      }
      this.pendingAssistant = null;
      if (this.activeChild === child) this.activeChild = null;
      if (!finalized) terminateProcessGroup(child);
    }
  }

  cancel(): void {
    if (!this.activeChild) return;
    this.activeCancelled = true;
    terminateProcessGroup(this.activeChild);
  }

  async setMode(modeId: string): Promise<void> {
    this.mode = modeId;
  }

  async setModel(modelId: string): Promise<void> {
    this.model = modelId;
  }
}

function readConversationId(logPath: string): string | null {
  let content: string;
  try {
    content = fs.readFileSync(logPath, "utf8");
  } catch {
    return null;
  }
  let latest: string | null = null;
  for (const match of content.matchAll(CONVERSATION_ID_RE)) latest = match[1];
  return latest;
}

function terminateProcessGroup(child: ChildProcessWithoutNullStreams): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
}
