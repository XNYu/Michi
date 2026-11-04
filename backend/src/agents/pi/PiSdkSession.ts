import { getRuntimeDeps } from "../runtimeDeps";
import { isRunOwner } from "../ownerMapping";
import type { AgentSession, CompactResult } from "../types";
import { PiSession, type PiSessionDeps } from "./PiSession";
import { createPiSdkHarness, invalidatePiSdkTranscript, type PiSdkFeatures } from './piSdkHarness';

export type PiSessionKind = "sdk" | "agent-core";
/** The old engine remains available for operational rollback. */
export function selectPiSessionKind(env: NodeJS.ProcessEnv = process.env): PiSessionKind {
  return env.MICHI_PI_SESSION_SDK === '0' ? 'agent-core' : 'sdk';
}

/** Michi branches always own an independent transcript. */
export function shouldNavigatePiTreeOnMichiBranch(): false { return false; }

export class PiSdkSession extends PiSession {
  private sdkHarness: any;
  constructor(id: string, private readonly sdkDeps: PiSessionDeps) { super(id, sdkDeps); }

  protected override async createHarness(core: any, options: any, features: PiSdkFeatures): Promise<any> {
    return this.sdkHarness = await createPiSdkHarness(this.id, this.sdkDeps, core, options, features);
  }

  protected override supportsToolSearch(): boolean { return true; }

  protected override async onTurnSettled(): Promise<void> {
    if (!this.sdkHarness) return;
    // ChatHub finalizes SQLite before returning the generator at turn_end.
    // Read that canonical view: it includes displayText, steered users and
    // finalized assistant sentinels, unlike the model-facing raw transcript.
    if (!isRunOwner(this.owner)) {
      const store = getRuntimeDeps().historyStore;
      if (store.getNode(this.id)) {
        this.sdkHarness.checkpoint(store.listMessages(this.id).filter(message =>
          (message.role === 'user' || message.role === 'assistant') && !!message.content,
        ).map(message => ({ role: message.role as 'user' | 'assistant', content: message.content ?? '' })));
        return;
      }
    }
    this.sdkHarness.checkpoint(this.getHistory());
  }

  override describeNativeState(): Record<string, unknown> {
    return { ...super.describeNativeState(), kind: 'pi-sdk' };
  }

  /** SDK manual compaction between turns (POST /chats/:chatId/compact). The agent-core rollback has none. */
  compact(instructions?: string): Promise<CompactResult> {
    return this.compactBetweenTurns(instructions);
  }
}

export async function createPiSession(id: string, deps: PiSessionDeps): Promise<AgentSession> {
  if (selectPiSessionKind() === 'sdk') return new PiSdkSession(id, deps);
  invalidatePiSdkTranscript(id, deps);
  return new PiSession(id, deps);
}
