import type { AgentSession } from "../types";
import { PiSession, type PiSessionDeps } from "./PiSession";

/**
 * The optional coding-agent experiment never wired an SDK-owned conversation.
 * Keep the historical factory/module boundary, but use the complete agent-core
 * session until an SDK transport implements the full AgentSession contract.
 * Installing a package or setting MICHI_PI_SESSION_SDK must not silently swap
 * the engine, drop attachments, or change owner/permission/steering behavior.
 */
export type PiSessionKind = "agent-core";
export function selectPiSessionKind(_env: NodeJS.ProcessEnv = process.env): PiSessionKind {
  return "agent-core";
}

/** Michi branches never navigate or mutate the parent's native Pi tree. */
export function shouldNavigatePiTreeOnMichiBranch(): false { return false; }

/** @deprecated Compatibility name; this is the real agent-core session. */
export class PiSdkSession extends PiSession {}

export async function createPiSession(id: string, deps: PiSessionDeps): Promise<AgentSession> {
  return new PiSession(id, deps);
}
