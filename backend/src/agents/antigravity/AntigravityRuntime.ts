import { spawn } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentCapabilities,
  AgentRuntime,
  AgentSession,
  LoadAgentSessionOptions,
  ModelInfo,
  NewAgentSessionOptions,
  SessionMode,
} from "../types";
import type { RuntimeModelCache } from "../runtimeModelCache";
import { getRuntimeDeps } from "../runtimeDeps";
import * as sessionRegistry from "../sessionRegistry";
import { buildFirstTurnPrefix } from "../preamble";
import { getNode, setNodeExternalSessionId } from "../../services/dbRepository";
import { AntigravitySession, AntigravityCliError } from "./AntigravitySession";
import { findAntigravityBinary, warnIfAntigravityVersionBelowMinimum } from "./antigravityBinary";
import {
  ensureAntigravityCustomization,
  warmAntigravityCustomization,
  type AntigravityCustomization,
} from "./antigravityCustomization";

const CAPABILITIES: AgentCapabilities = {
  modes: true,
  permissions: false,
  models: true,
  providerModels: false,
  reasoning: false,
  supportedReasoningLevels: [],
  apiKeys: false,
  warmSessions: false,
  saveContext: false,
  spawnBranches: false,
  nativeResume: true,
};

export interface AntigravityRuntimeOptions {
  binaryPath?: string;
  modelCache?: RuntimeModelCache;
}

export class AntigravitySessionNotResumableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AntigravitySessionNotResumableError";
  }
}

/**
 * Runtime for the public Antigravity CLI (`agy`). AGY exposes a Claude-like
 * process-per-turn `--print` mode with native conversation resume, but no
 * public ACP/app-server protocol. Capabilities intentionally describe that
 * smaller surface instead of advertising Michi MCP or permission parity.
 */
export class AntigravityRuntime implements AgentRuntime {
  public readonly id = "antigravity";
  public readonly label = "Antigravity";
  public readonly capabilities = CAPABILITIES;

  private readonly binaryPathOverride?: string;
  private readonly modelCacheStore?: RuntimeModelCache;
  private readonly sessions = new Map<string, AntigravitySession>();
  private modelCache: ModelInfo[] | null;
  private modelRefreshLock: Promise<ModelInfo[]> | null = null;
  private customization: AntigravityCustomization | null = null;

  constructor(options: AntigravityRuntimeOptions = {}) {
    this.binaryPathOverride = options.binaryPath;
    this.modelCacheStore = options.modelCache;
    this.modelCache = options.modelCache?.load(this.id) ?? null;
    setImmediate(() => warnIfAntigravityVersionBelowMinimum());
  }

  private binaryPath(): string {
    return this.binaryPathOverride ?? findAntigravityBinary();
  }

  async warm(_cwd: string, _opts?: { model?: string | null }): Promise<void> {
    const binaryPath = this.binaryPath();
    const customization = this.ensureCustomization();
    await warmAntigravityCustomization(binaryPath, customization);
    // AGY has no reusable public daemon. Refresh the catalog opportunistically
    // without making /warm wait through a 5-15 second auth/bootstrap cycle.
    void this.refreshModels().catch((err: unknown) => {
      console.warn("[AntigravityRuntime] model refresh during warm failed:", (err as Error).message);
    });
  }

  async newSession(opts: NewAgentSessionOptions): Promise<AgentSession> {
    const nodeId = opts.sessionId ?? randomUUID();
    const existing = this.sessions.get(nodeId);
    if (existing) return existing;

    const ancestorChain: AgentSession[] = [];
    if (opts.parentChatId) {
      sessionRegistry.ensureAncestorChainLoaded(opts.parentChatId);
      const parent = sessionRegistry.getSession(opts.parentChatId);
      if (parent) ancestorChain.push(...sessionRegistry.getAncestors(opts.parentChatId), parent);
    }
    const deps = getRuntimeDeps();
    const workspaceInstructions = opts.workspaceId
      ? deps.historyStore.getWorkspaceInstructions(opts.workspaceId)
      : null;
    const firstTurnPrefix = buildFirstTurnPrefix({
      cwd: opts.cwd,
      contextManifest: opts.contextManifest,
      extraContexts: opts.extraContexts,
      ancestors: ancestorChain,
      mergeContexts: opts.mergeContexts,
      workspaceInstructions,
    });

    const session = this.createSession({
      nodeId,
      cwd: opts.cwd,
      parentChatId: opts.parentChatId,
      model: opts.model,
      firstTurnPrefix,
      enableFollowUps: opts.enableFollowUps,
    });
    this.sessions.set(nodeId, session);
    return session;
  }

  async loadSession(opts: LoadAgentSessionOptions): Promise<AgentSession> {
    const nodeId = opts.sessionId;
    const existing = this.sessions.get(nodeId);
    if (existing) return existing;
    const node = getNode(nodeId);
    const conversationId = node?.external_session_id ?? null;
    if (!conversationId) {
      throw new AntigravitySessionNotResumableError(
        `Node ${nodeId} has no external_session_id — cannot resume Antigravity conversation`,
      );
    }
    const session = this.createSession({
      nodeId,
      cwd: opts.cwd,
      model: opts.model,
      externalConversationId: conversationId,
    });
    this.sessions.set(nodeId, session);
    return session;
  }

  private createSession(input: {
    nodeId: string;
    cwd: string;
    parentChatId?: string;
    model?: string | null;
    externalConversationId?: string | null;
    firstTurnPrefix?: string;
    enableFollowUps?: boolean;
  }): AntigravitySession {
    const customization = this.ensureCustomization();
    const logDir = path.join(getRuntimeDeps().dataDir, "runtime-logs", "antigravity");
    return new AntigravitySession({
      ...input,
      binaryPath: this.binaryPath(),
      logDir,
      customizationDir: customization.rootDir,
      agentName: customization.agentName,
      onConversationId: (conversationId) => {
        try {
          setNodeExternalSessionId(input.nodeId, conversationId);
        } catch (err) {
          console.warn("[AntigravityRuntime] failed to persist conversation id:", (err as Error).message);
        }
      },
    });
  }

  async releaseSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    session?.cancel();
    this.sessions.delete(sessionId);
    sessionRegistry.dropSession(sessionId);
  }

  async listModes(_sessionId: string): Promise<SessionMode[]> {
    return [
      { id: "default", label: "Request review", description: "Review file edits before AGY applies them." },
      { id: "accept-edits", label: "Accept edits", description: "Automatically accept workspace file edits." },
      { id: "plan", label: "Plan", description: "Read-only planning mode." },
      { id: "sandbox", label: "Sandbox", description: "Use default review behavior with terminal sandbox restrictions." },
    ];
  }

  private ensureCustomization(): AntigravityCustomization {
    if (!this.customization) {
      this.customization = ensureAntigravityCustomization(getRuntimeDeps().dataDir);
    }
    return this.customization;
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelCache) {
      void this.refreshModels().catch((err: unknown) => {
        console.warn("[AntigravityRuntime] model refresh failed; using cached catalog:", (err as Error).message);
      });
      return this.modelCache;
    }
    return this.refreshModels();
  }

  async refreshModels(): Promise<ModelInfo[]> {
    if (this.modelRefreshLock) return this.modelRefreshLock;
    this.modelRefreshLock = (async () => {
      try {
        const { stdout, stderr } = await runModelsCommand(this.binaryPath());
        const models = parseModelCatalog(stdout);
        if (models.length === 0) {
          const detail = `${stdout}\n${stderr}`.trim();
          throw new AntigravityCliError(detail || "agy models returned an empty catalog");
        }
        this.modelCache = models;
        this.modelCacheStore?.save(this.id, models);
        return models;
      } catch (err) {
        const failure = err as Error & { stdout?: string; stderr?: string };
        const detail = [failure.stdout, failure.stderr, failure.message].filter(Boolean).join("\n").trim();
        throw new AntigravityCliError(detail || "Unable to load Antigravity models");
      }
    })().finally(() => {
      this.modelRefreshLock = null;
    });
    return this.modelRefreshLock;
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) session.cancel();
    this.sessions.clear();
  }
}

async function runModelsCommand(binaryPath: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ["models"], {
      // AGY keeps waiting when Node leaves its stdin pipe open. An ignored
      // stdin matches normal non-interactive shell invocation and lets the
      // catalog command exit as soon as it has printed the models.
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      const error = new Error(`agy models timed out after 60000ms`) as Error & {
        stdout?: string;
        stderr?: string;
      };
      error.stdout = Buffer.concat(stdout).toString();
      error.stderr = Buffer.concat(stderr).toString();
      reject(error);
    }, 60_000);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString();
      const errors = Buffer.concat(stderr).toString();
      if (code === 0) {
        resolve({ stdout: output, stderr: errors });
        return;
      }
      const error = new Error(
        `agy models exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`,
      ) as Error & { stdout?: string; stderr?: string };
      error.stdout = output;
      error.stderr = errors;
      reject(error);
    });
  });
}

export function parseModelCatalog(output: string): ModelInfo[] {
  const seen = new Set<string>();
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^error:/i.test(line))
    .filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    })
    .map((label, index) => ({ id: label, label, isDefault: index === 0 ? true : undefined }));
}
