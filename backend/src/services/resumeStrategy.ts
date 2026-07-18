import type { AgentConfig } from "./agentConfig";
import { getBuiltinDefaultModel, getBuiltinDefaultReasoning } from "./agentConfig";
import type { AgentReasoning, AgentRuntime } from "../agents/types";
import {
  computeTranscriptFingerprint as computeSharedTranscriptFingerprint,
  type TranscriptFingerprintMessage,
} from "michi-shared";

export type ResumeStrategy = "fresh" | "live" | "exact" | "compatible";

export interface ResumeSignature {
  runtimeId: string;
  providerId: string | null;
  modelId: string | null;
  reasoning: AgentReasoning | null;
}

export type TranscriptMessage = TranscriptFingerprintMessage;

export interface ResumeDecisionInput {
  existingChatId?: string | null;
  liveSessionMatches: boolean;
  nativeResumeAvailable: boolean;
  existingSignature: ResumeSignature | null;
  targetSignature: ResumeSignature;
  storedFingerprint?: string | null;
  currentFingerprint: string;
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
): ResumeSignature {
  const runtimeId = cfg.runtime;
  const modelId = normalizeSignaturePart(
    modelOverride ??
    cfg.modelByRuntime[runtimeId] ??
    getBuiltinDefaultModel(runtimeId),
  );
  return {
    runtimeId,
    providerId: runtime.capabilities.providerModels ? normalizeSignaturePart(cfg.provider) : null,
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
  if (!input.existingSignature) {
    return { strategy: "compatible", reason: "missing_resume_signature" };
  }
  if (!signaturesEqual(input.existingSignature, input.targetSignature)) {
    return { strategy: "compatible", reason: "signature_changed" };
  }
  if (!input.storedFingerprint || input.storedFingerprint !== input.currentFingerprint) {
    return { strategy: "compatible", reason: "transcript_changed" };
  }
  if (input.liveSessionMatches) {
    return { strategy: "live", reason: "live_session_matches" };
  }
  if (input.nativeResumeAvailable) {
    return { strategy: "exact", reason: "native_resume_available" };
  }
  return { strategy: "compatible", reason: "native_resume_unavailable" };
}

export function computeTranscriptFingerprint(messages: readonly TranscriptMessage[]): string {
  return computeSharedTranscriptFingerprint(messages);
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
