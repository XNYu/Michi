import type { AgentConfig } from "./agentConfig";
import { getBuiltinDefaultModel, getBuiltinDefaultReasoning, resolveProvider } from "./agentConfig";
import type { AgentReasoning, AgentRuntime } from "../agents/types";

export type ResumeStrategy = "fresh" | "live" | "exact" | "compatible";

export interface ResumeSignature {
  runtimeId: string;
  providerId: string | null;
  modelId: string | null;
  reasoning: AgentReasoning | null;
}

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ResumeDecisionInput {
  existingChatId?: string | null;
  liveSessionMatches: boolean;
  nativeResumeAvailable: boolean;
  nativeResumeSettings?: readonly ('model' | 'reasoning')[];
  existingSignature: ResumeSignature | null;
  targetSignature: ResumeSignature;
  /** @deprecated Fingerprint check removed — field ignored by chooseResumeStrategy. */
  storedFingerprint?: string | null;
  /** @deprecated Fingerprint check removed — field ignored by chooseResumeStrategy. */
  currentFingerprint?: string;
}

export interface ResumeDecision {
  strategy: ResumeStrategy;
  reason: string;
}

const MAX_COMPAT_TRANSCRIPT_CHARS = 28_000;
const COMPAT_TRANSCRIPT_HEAD = 8_000;
const COMPAT_TRANSCRIPT_TAIL = 16_000;

export function normalizeSignaturePart(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function normalizeReasoning(value: unknown): AgentReasoning | null {
  const normalized = normalizeSignaturePart(value);
  if (
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh" ||
    normalized === "max"
  ) {
    return normalized;
  }
  return null;
}

export function buildTargetResumeSignature(
  cfg: AgentConfig,
  runtime: AgentRuntime,
  modelOverride?: string | null,
  userId?: string,
): ResumeSignature {
  const runtimeId = cfg.runtime;
  const modelId = normalizeSignaturePart(
    modelOverride ??
    cfg.modelByRuntime[runtimeId] ??
    getBuiltinDefaultModel(runtimeId),
  );
  return {
    runtimeId,
    providerId: runtime.capabilities.providerModels ? normalizeSignaturePart(resolveProvider(runtimeId, userId)) : null,
    modelId,
    reasoning: runtime.capabilities.reasoning
      ? normalizeReasoning(cfg.reasoningByRuntime[runtimeId] ?? getBuiltinDefaultReasoning(runtimeId))
      : null,
  };
}

export function normalizeResumeSignature(input: {
  runtimeId?: unknown;
  providerId?: unknown;
  modelId?: unknown;
  reasoning?: unknown;
}): ResumeSignature | null {
  const runtimeId = normalizeSignaturePart(input.runtimeId);
  if (!runtimeId) return null;
  return {
    runtimeId,
    providerId: normalizeSignaturePart(input.providerId),
    modelId: normalizeSignaturePart(input.modelId),
    reasoning: normalizeReasoning(input.reasoning),
  };
}

export function signaturesEqual(a: ResumeSignature, b: ResumeSignature): boolean {
  return (
    a.runtimeId === b.runtimeId &&
    a.providerId === b.providerId &&
    a.modelId === b.modelId &&
    a.reasoning === b.reasoning
  );
}

export function chooseResumeStrategy(input: ResumeDecisionInput): ResumeDecision {
  if (!input.existingChatId) {
    return { strategy: "fresh", reason: "no_existing_session" };
  }
  if (!input.existingSignature && !input.nativeResumeAvailable && !input.liveSessionMatches) {
    return { strategy: "compatible", reason: "missing_resume_signature" };
  }
  const existing = input.existingSignature;
  const target = input.targetSignature;
  if (existing && !signaturesEqual(existing, target)) {
    const supported = input.nativeResumeSettings ?? [];
    if (existing.runtimeId !== target.runtimeId || existing.providerId !== target.providerId
      || (existing.modelId !== target.modelId && !supported.includes('model'))
      || (existing.reasoning !== target.reasoning && !supported.includes('reasoning'))) {
      return { strategy: "compatible", reason: "signature_changed" };
    }
  }
  // Fingerprint check removed: Pane Ownership already prevents concurrent
  // writes, edit/retry clears chatId (forcing fresh), and the fingerprint's
  // normalization divergence caused every normal follow-up to misfire into
  // compatible resume — losing live sessions that were perfectly fine.
  if (input.liveSessionMatches) {
    return { strategy: "live", reason: "live_session_matches" };
  }
  if (input.nativeResumeAvailable) {
    return { strategy: "exact", reason: "native_resume_available" };
  }
  return { strategy: "compatible", reason: "native_resume_unavailable" };
}

export function buildCompatibleResumeContext(
  messages: readonly TranscriptMessage[],
  opts: { nodeId: string; title?: string | null },
): string | null {
  const nonEmpty = messages.filter((m) => m.content.trim().length > 0);
  if (nonEmpty.length === 0) return null;
  const label = opts.title?.trim() || opts.nodeId;
  const transcript = nonEmpty
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}:\n${m.content}`)
    .join("\n\n---\n\n");
  const body = truncateMiddle(transcript, MAX_COMPAT_TRANSCRIPT_CHARS);
  return [
    `=== Compatible resume transcript: ${label} ===`,
    "The following is the visible transcript from this node. It may come from a different runtime, provider, or model. Treat it as prior conversation context and continue naturally; do not mention the restore mode unless the user asks.",
    "",
    body,
  ].join("\n");
}

function truncateMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, COMPAT_TRANSCRIPT_HEAD).trimEnd();
  const tail = text.slice(-COMPAT_TRANSCRIPT_TAIL).trimStart();
  const omitted = text.length - head.length - tail.length;
  return `${head}\n\n[... omitted ${omitted} chars from the middle of the prior transcript ...]\n\n${tail}`;
}
