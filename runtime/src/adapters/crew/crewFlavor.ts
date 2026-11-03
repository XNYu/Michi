import { isCrewMemoryMode } from 'michi-shared';
import type { AcpAgentFlavor, KiroSessionMemory } from '../kiro/acpAgentFlavor';
import { rewindPoints } from '../kiro/kiroProtocol';
import type { AcpClient } from '../kiro/acpClient';
import type { CancelAck } from '../../contract/types';

/** Longer than the adapter's 10 s stop grace, inside its 15 s ACP cancel limit. */
const CANCEL_STATUS_TIMEOUT_MS = 12_000;

/**
 * The Gateway's record of the stop the adapter sent for the cancelled prompt
 * (its `stop_event` row, read through the adapter's `cancel_status`
 * command). `stopped` and `stop_failed_reset` confirm it; anything else,
 * including no record in time, leaves the dispatch as an inferred ack.
 */
async function crewCancelAck(client: AcpClient, sid: string): Promise<CancelAck | undefined> {
    const result = await client.executeCommand(sid, 'cancel_status', {}, CANCEL_STATUS_TIMEOUT_MS);
    const report = result.data as { confirmed?: unknown; state?: unknown; outcome?: unknown } | undefined;
    if (!result.success || report?.confirmed !== true) return undefined;
    const state = typeof report.state === 'string' ? report.state : 'stopped';
    return { acknowledged: true, source: 'native', confidence: 'native', nativeMethod: `Crew stop_event ${state}` };
}

/**
 * A Crew chat's memory mode: the caller's, else the one the chat pinned,
 * else the owner's default. It goes into session/new and is pinned for the
 * chat, as is the mode a loaded session reports.
 */
const CREW_MEMORY: KiroSessionMemory = {
    forNewSession(host, opts) {
        const saved = opts.sessionId ? host.bindings.nodeBinding(opts.sessionId)?.crew_memory_mode : undefined;
        const mode = opts.crewMemoryMode ?? (isCrewMemoryMode(saved) ? saved : host.bindings.crewMemory!.defaultMode(opts.ownerUserId));
        return mode ? { metadata: { crew: { memoryMode: mode } }, keep: (nodeId) => host.bindings.crewMemory!.pin(nodeId, mode) } : undefined;
    },
    keepLoaded(host, nodeId, meta) {
        if (isCrewMemoryMode(meta?.crewMemoryMode)) host.bindings.crewMemory!.pin(nodeId, meta.crewMemoryMode);
    },
};

/**
 * Kiro Crew through its ACP adapter, as a flavor of the Kiro runtime. Its
 * agent template (crew-app/agents) holds the stable instructions and its
 * agents report turn metadata as answer lines, so a chat gets only the
 * host's variable first-turn prefix. The adapter forwards the Gateway's
 * session titles. A Gateway session may hold a private memory identity or a
 * restricted memory mode, so a lost one is never silently rebuilt. Its
 * adapter's rewind points carry the Gateway message id it forks at, so that
 * id is the fork anchor. Crew sessions keep one MCP slot each. A new
 * session names its Michi workspace, so the adapter can file it in the
 * Crew sidebar folder of that workspace. A cancel is acknowledged by the
 * Gateway's own stop record when one arrives.
 */
export const CREW_KIRO_FLAVOR: AcpAgentFlavor = {
    hostPorts: ['bindings.crewMemory'],
    prompt: {
        firstMessage: (host, input) => host.prompt.firstTurnPrefix(input),
        metadataChannel: 'inline',
    },
    sessionInfoEvents: (update) => typeof update.title === 'string' && update.title.trim()
        ? [{ kind: 'title', title: update.title.trim() }] : [],
    nativeSessions: {
        replaceable: false,
        forkAnchor: async (client, sid) => ({ messageId: rewindPoints(await client.executeCommand(sid, 'rewind', {}, 5_000))[0]?.messageId }),
    },
    sessionAnchors: false,
    memory: CREW_MEMORY,
    cancelAck: { kind: 'agent-record', confirm: crewCancelAck },
    sessionMetadata(host, opts) {
        const name = opts.workspaceId ? host.bindings.workspace(opts.workspaceId)?.name?.trim() : undefined;
        return name ? { crew: { workspaceName: name } } : undefined;
    },
};
