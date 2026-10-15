import { isReasoningLevel, sanitizeReasoningLevels, parseSessionState, type AgentSessionState } from 'michi-shared';
import type { AcpSessionInfo } from './kiroProtocol';

let stateVersion = Date.now();

type Snapshot = { version?: number; commands?: unknown[]; servers?: any[]; tools?: unknown[] };

/** Only bounded, replaceable state survives queue draining. Never keep text,
 * tool execution deltas, permissions or turn completion here. */
export class KiroSessionSnapshots {
    private readonly sessions = new Map<string, Snapshot>();
    private readonly listeners = new Map<string, Set<() => void>>();

    set(sessionId: string, patch: Snapshot): void {
        const value = { ...this.sessions.get(sessionId), ...patch };
        this.sessions.delete(sessionId);
        this.sessions.set(sessionId, value);
        // Pre-response notifications can contain an as-yet unknown session ID.
        // V3 workers own one chat, but still bound unsolicited identities.
        while (this.sessions.size > 128) this.sessions.delete(this.sessions.keys().next().value!);
    }
    get(sessionId: string): Snapshot | undefined { return this.sessions.get(sessionId); }
    delete(sessionId: string): void { this.sessions.delete(sessionId); this.listeners.delete(sessionId); }
    changed(sessionId: string): void {
        stateVersion = Math.max(Date.now(), stateVersion + 1);
        this.set(sessionId, { version: stateVersion });
        for (const notify of this.listeners.get(sessionId) ?? []) notify();
    }
    subscribe(sessionId: string, notify: () => void): () => void {
        const listeners = this.listeners.get(sessionId) ?? new Set();
        listeners.add(notify); this.listeners.set(sessionId, listeners);
        return () => { listeners.delete(notify); if (!listeners.size) this.listeners.delete(sessionId); };
    }
    state(sessionId: string, info?: AcpSessionInfo): AgentSessionState {
        const snapshot = this.get(sessionId);
        const effort = info?.configOptions?.find((option) => option.id === 'effortLevel');
        return parseSessionState({ runtimeId: 'kiro', version: snapshot?.version,
            ...(info?.modes ? { currentModeId: info.modes.currentModeId, availableModes: info.modes.availableModes } : {}),
            ...(info?.models ? { modelId: info.models.currentModelId,
                availableModels: info.models.availableModels?.map((model: any) => ({
                    id: model.modelId, label: model.name, description: model.description,
                    ...(model._meta?.kiro ? {
                        supportsReasoning: model._meta.kiro.hasEffort,
                        supportedReasoningLevels: sanitizeReasoningLevels(model._meta.kiro.effortLevels),
                        defaultReasoning: model._meta.kiro.defaultEffortLevel,
                    } : {}),
                })),
            } : {}),
            ...(info?.configOptions ? { reasoning: isReasoningLevel(effort?.currentValue) ? effort.currentValue : null } : {}),
            ...(snapshot?.commands ? { commands: snapshot.commands } : {}),
            ...(snapshot?.servers ? { mcpErrors: snapshot.servers.filter((server) => server.status === 'failed' || server.status === 'error')
                .map((server) => ({ serverName: String(server.name ?? ''),
                    error: typeof server.errorMessage === 'string' ? server.errorMessage
                        : typeof server.error === 'string' ? server.error : 'MCP server connection failed',
                })) } : {}),
        });
    }
}
