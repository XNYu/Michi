import { ACPError, ACPProcessExitedError, ACPNotRunningError } from "../../services/acpClient";

/**
 * kiro-cli collapses every runtime failure into JSON-RPC `-32603 "Internal
 * error"`; the discriminator lives entirely in the `rpcData` string (the ACP
 * spec defines no structured auth/rate-limit codes). kiro-cli is built on the
 * AWS Rust SDK (aws-smithy) + the CodeWhisperer/Q streaming client, so the
 * observable error surface is that stack's taxonomy. Fixtures for every branch
 * below are the exact strings seen in ~/.michi/logs/backend.log plus markers
 * lifted from the kiro-cli binary's baked-in error variants.
 *
 * Four internal classes; the UI collapses to three (see toErrorKind):
 *   - connection: the SDK connection/process is dead — respawn required.
 *   - transient:  service-side blip — a same-session resend usually clears it.
 *   - auth:       SSO/OIDC token expired — no retry, prompt re-login.
 *   - generic:    validation / quota / anything else — surface raw, no retry.
 */
export type AcpErrorClass = "connection" | "transient" | "auth" | "generic";

/** UI-facing collapse: connection + transient both read as a "connection" banner. */
export type AcpErrorKind = "connection" | "auth" | "generic";

// SSO/OIDC re-authentication needed. Checked first (before quota/transient) so a
// token error never masquerades as retryable.
const AUTH_MARKERS = [
  "expiredtokenexception",
  "invalidgrantexception",
  "unauthorizedclientexception",
  "notauthorizedexception",
  "authorizationpendingexception",
];

// Usage caps / capacity. Checked before transient + connection so a quota error
// wrapped in the "response stream" envelope is never retried.
const QUOTA_MARKERS = [
  "monthlyrequestcount",
  "dailyrequestcount",
  "insufficientmodelcapacity",
];

// Service-side transient — connection is fine, a same-session resend clears it.
const TRANSIENT_MARKERS = [
  "throttl", // throttled / ThrottlingError
  "modeltemporarilyunavailable",
  "model_temporarily_unavailable",
  "internalserver", // InternalServerError / InternalServerException
  "failed to generate a response",
];

// Connection/transport layer is dead — the request never completed. Requires a
// fresh kiro process. Checked last so more-specific classes win the envelope.
const CONNECTION_MARKERS = [
  "dispatch failure",
  "dispatchfailure",
  "response stream", // "Encountered an error in the response stream: ..."
  "timed out",
  "request has timed out",
  "timeouterror",
  "providertimedout",
  "stalledstream",
  "connection reset",
  "host unreachable",
  "responseerror",
];

function haystack(err: unknown): string {
  if (!(err instanceof Error)) return typeof err === "string" ? err.toLowerCase() : "";
  let text = err.message ?? "";
  if (err instanceof ACPError && err.rpcData != null) {
    text += " " + (typeof err.rpcData === "string" ? err.rpcData : safeStringify(err.rpcData));
  }
  return text.toLowerCase();
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function matchesAny(hay: string, markers: string[]): boolean {
  return markers.some((m) => hay.includes(m));
}

export function classifyAcpError(err: unknown): AcpErrorClass {
  // A dead process is unambiguously a connection failure regardless of message.
  if (err instanceof ACPProcessExitedError || err instanceof ACPNotRunningError) {
    return "connection";
  }
  const hay = haystack(err);
  if (matchesAny(hay, AUTH_MARKERS)) return "auth";
  if (matchesAny(hay, QUOTA_MARKERS)) return "generic";
  if (matchesAny(hay, TRANSIENT_MARKERS)) return "transient";
  if (matchesAny(hay, CONNECTION_MARKERS)) return "connection";
  return "generic";
}

/** True for classes where a single automatic retry is worthwhile. */
export function isRetryable(cls: AcpErrorClass): boolean {
  return cls === "connection" || cls === "transient";
}

/** True only when recovery must spawn a fresh kiro process (dead connection). */
export function needsRespawn(cls: AcpErrorClass): boolean {
  return cls === "connection";
}

/** Collapse the 4 internal classes to the 3 the UI banner distinguishes. */
export function toErrorKind(cls: AcpErrorClass): AcpErrorKind {
  if (cls === "auth") return "auth";
  if (cls === "generic") return "generic";
  return "connection";
}
