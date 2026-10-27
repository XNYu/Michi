import { isCrewMemoryMode } from 'michi-shared';
import type { KiroFlavor, KiroSessionMemory } from '../kiro/kiroFlavor';
import { rewindPoints } from '../kiro/kiroProtocol';

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
 * id is the fork anchor. Crew sessions keep one MCP slot each.
 */
export const CREW_KIRO_FLAVOR: KiroFlavor = {
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
};
