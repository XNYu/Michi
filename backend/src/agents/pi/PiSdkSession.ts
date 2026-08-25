import type { AgentSession, CancelAck, ChatMessage, CompactResult, SteerResult } from "../types";
import type { NormalizedEvent } from "../../services/chatEvents";
import type { AgentTurnInput } from "../types";
import { PiSession, type PiSessionDeps } from "./PiSession";
import { isPiSessionSdkEnabled } from "./piSdkFlag";

export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

export type PiSessionKind = "sdk" | "agent-core";

export function selectPiSessionKind(env: NodeJS.ProcessEnv = process.env): PiSessionKind {
  return isPiSessionSdkEnabled(env) ? "sdk" : "agent-core";
}

/**
 * Michi conversation fork never mutates a parent Pi session tree.
 * Native navigateTree is resume/debug detail only.
 */
export function shouldNavigatePiTreeOnMichiBranch(): false {
  return false;
}

export interface PiSdkRuntimeAdapter {
  steer?(text: string): Promise<void> | void;
  followUp?(text: string): Promise<void> | void;
  compact?(instructions?: string): Promise<void> | void;
  abort?(): void;
  navigateTree?: (...args: unknown[]) => void;
}

export async function tryLoadPiCodingAgent(): Promise<{ createAgentSession?: (...args: unknown[]) => unknown } | null> {
  try {
    return await import(PI_CODING_AGENT_PACKAGE);
  } catch {
    return null;
  }
}

/**
 * Optional Pi SDK session. When the coding-agent package is missing, callers
 * must fall back to PiSession (agent-core). This class never replaces Map/Digest.
 */
export class PiSdkSession implements AgentSession {
  public readonly id: string;
  public readonly runtimeId = "pi";
  public readonly parentChatId?: string;
  public currentModeId: string | null = null;
  public currentModelId: string | null = null;

  private readonly fallback: PiSession;
  private readonly sdk: PiSdkRuntimeAdapter | null;

  constructor(id: string, deps: PiSessionDeps, sdk: PiSdkRuntimeAdapter | null = null) {
    this.id = id;
    this.parentChatId = deps.parentChatId;
    this.fallback = new PiSession(id, deps);
    this.sdk = sdk;
  }

  getHistory(): ChatMessage[] {
    return this.fallback.getHistory();
  }

  getPendingAssistant(): string | undefined {
    return this.fallback.getPendingAssistant();
  }

  send(text: string, _input?: AgentTurnInput): AsyncIterableIterator<NormalizedEvent> {
    return this.fallback.send(text);
  }

  cancel(): CancelAck {
    this.sdk?.abort?.();
    return this.fallback.cancel();
  }

  async steer(text: string): Promise<SteerResult> {
    if (!this.sdk?.steer) return { accepted: false, reason: "invisible" };
    await this.sdk.steer(text);
    return { accepted: true, pending: true };
  }

  async followUp(text: string): Promise<SteerResult> {
    if (!this.sdk?.followUp) return { accepted: false, reason: "invisible" };
    await this.sdk.followUp(text);
    return { accepted: true, pending: true };
  }

  async compact(instructions?: string): Promise<CompactResult> {
    if (!this.sdk?.compact) return { started: false };
    await this.sdk.compact(instructions);
    return { started: true };
  }

  describeNativeState(): Record<string, unknown> {
    return {
      kind: "pi-sdk",
      michiNodeId: this.id,
      navigatesParentTree: shouldNavigatePiTreeOnMichiBranch(),
    };
  }

  destroy(): void {
    this.fallback.destroy();
  }
}

export async function createPiSession(
  id: string,
  deps: PiSessionDeps,
): Promise<AgentSession> {
  if (selectPiSessionKind() !== "sdk") {
    return new PiSession(id, deps);
  }
  const mod = await tryLoadPiCodingAgent();
  if (!mod?.createAgentSession) {
    return new PiSession(id, deps);
  }
  return new PiSdkSession(id, deps);
}
