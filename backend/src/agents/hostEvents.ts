import type { ChatStreamPayloads, SpawnBranchTopic } from "michi-shared";
import type { NormalizedEvent } from "../services/chatEvents";
import { log } from "../services/logger";

/**
 * Michi's product events: what Michi's tools (spawn_branches, save_artifact,
 * update_artifact, show_image, set_branch_overview, set_follow_ups) report
 * through a runtime session. The runtime contract carries them as host
 * events; `type` is the SSE event name the client reads and `payload` is
 * that event's data, field for field.
 *
 * Michi's tool handlers (services/mcpServer.ts) report spawn_branches,
 * artifact_saved, artifact_updated and image through the slot's session
 * sink (the Claude, Codex and Kiro adapters give every slot one). For the
 * turn metadata, and for Pi's in-process tools, the adapter builds the host
 * event itself (the runtime layer cannot import this module). Michi decodes
 * them here.
 */
export const MICHI_HOST_EVENT_TYPES = [
    "spawn_branches",
    "branch_overview",
    "follow_ups",
    "follow_ups_status",
    "artifact_saved",
    "artifact_updated",
    "image",
] as const;

export type MichiHostEventType = (typeof MICHI_HOST_EVENT_TYPES)[number];

export type MichiHostEvent = {
    [T in MichiHostEventType]: { type: T; payload: ChatStreamPayloads[T] };
}[MichiHostEventType];

export type HostEvent = Extract<NormalizedEvent, { kind: "host_event" }>;

export function encodeMichiHostEvent(event: MichiHostEvent): HostEvent {
    return { kind: "host_event", type: event.type, payload: event.payload };
}

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptional(value: unknown, type: "string" | "number"): boolean {
    return value === undefined || typeof value === type;
}

function isSpawnTopic(value: unknown): value is SpawnBranchTopic {
    return isFields(value) && typeof value.title === "string" && typeof value.prompt === "string"
        && typeof value.chatId === "string" && isOptional(value.nodeId, "string");
}

function artifact(p: Fields): ChatStreamPayloads["artifact_saved"] | null {
    if (typeof p.name !== "string" || typeof p.filePath !== "string") return null;
    if (!isOptional(p.contextId, "string") || !isOptional(p.size, "number")) return null;
    return { contextId: p.contextId as string | undefined, name: p.name, filePath: p.filePath, size: p.size as number | undefined };
}

/** One warning per problem and type (as logged), for at most this many distinct problems. */
const MAX_WARNINGS = 32;
const warned = new Set<string>();

type Problem =
    | "host event dropped: unknown type"
    | "host event dropped: malformed payload"
    | "host event kept without its malformed topics";

function warnOnce(problem: Problem, type: string): void {
    const logged = type.slice(0, 64);
    const key = `${problem}\0${logged}`;
    if (warned.has(key) || warned.size >= MAX_WARNINGS) return;
    warned.add(key);
    log.warn("chat", problem, { type: logged });
}

/** Test-only: forget which problems were already logged. */
export function __resetHostEventWarnings(): void {
    warned.clear();
}

/**
 * The branches a spawn_branches event reports. They already exist, so a
 * malformed topic is left out rather than dropping the whole event, as the
 * client's parser always did; with none left the event is dropped.
 */
function spawnedBranches(p: Fields): ChatStreamPayloads["spawn_branches"] | null {
    if (!Array.isArray(p.topics)) return null;
    const topics = p.topics.filter(isSpawnTopic);
    if (topics.length === p.topics.length) return { topics: p.topics };
    if (topics.length === 0) return null;
    warnOnce("host event kept without its malformed topics", "spawn_branches");
    return { topics };
}

/**
 * Payload checks, one per type. Each rebuilds the payload with the fields
 * and field order the client has always received; arrays pass through as
 * reported. (The shared wire parsers coerce rather than reject, and rebuild
 * array entries, so they cannot serve here.)
 */
const PAYLOADS: { [T in MichiHostEventType]: (p: Fields) => ChatStreamPayloads[T] | null } = {
    spawn_branches: spawnedBranches,
    branch_overview: (p) => typeof p.overview === "string" ? { overview: p.overview } : null,
    follow_ups: (p) => Array.isArray(p.followUps) && p.followUps.every((item) => typeof item === "string")
        ? { followUps: p.followUps }
        : null,
    follow_ups_status: (p) => p.status === "in_progress" || p.status === "completed" || p.status === "failed"
        ? { status: p.status }
        : null,
    artifact_saved: artifact,
    artifact_updated: artifact,
    image: (p) => typeof p.path === "string" && isOptional(p.caption, "string")
        && typeof p.mimeType === "string" && typeof p.size === "number"
        ? { path: p.path, caption: p.caption as string | undefined, mimeType: p.mimeType, size: p.size }
        : null,
};

const MICHI_TYPES: ReadonlySet<string> = new Set(MICHI_HOST_EVENT_TYPES);

function isMichiHostEventType(type: string): type is MichiHostEventType {
    return MICHI_TYPES.has(type);
}

/**
 * The Michi product event a host event carries, or null when its type is
 * not one of Michi's or its payload does not have that type's shape. Such
 * events are dropped; each kind of problem is logged once per type.
 */
export function decodeMichiHostEvent(event: HostEvent): MichiHostEvent | null {
    if (!isMichiHostEventType(event.type)) {
        warnOnce("host event dropped: unknown type", event.type);
        return null;
    }
    const payload = isFields(event.payload) ? PAYLOADS[event.type](event.payload) : null;
    if (!payload) {
        warnOnce("host event dropped: malformed payload", event.type);
        return null;
    }
    return { type: event.type, payload } as MichiHostEvent;
}
