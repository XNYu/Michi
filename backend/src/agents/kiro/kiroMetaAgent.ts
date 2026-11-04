/**
 * The Meta agent on Kiro, both engines. kiro-cli trusts the tools of the agent
 * it runs, so Michi writes a dedicated agent config into its own data
 * directory and runs a separate kiro-cli there, where Kiro finds the config as
 * a workspace agent. Michi selects that agent (v2 `--agent`, v3
 * `session/set_mode`), checks the tool catalog Kiro publishes before the first
 * prompt, and rejects every permission request.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MetaAgentToolset } from 'michi-shared';
import type { AcpClient, AcpClientOptions, AcpToolCatalogState } from 'michi-runtime/internal/adapters/kiro/acpClient';
import type { RuntimeToolProfile } from '../types';
import { assertMetaAgentToolCatalog, metaAgentCatalogUnavailable, metaAgentToolsetOf } from '../metaAgentGuard';
import type { KiroEngine } from 'michi-runtime/internal/adapters/kiro/kiroProtocol';

export const KIRO_META_AGENT_NAMES: Readonly<Record<MetaAgentToolset, string>> = Object.freeze({
    maintenance: 'michi-meta-agent-maintenance',
    chat: 'michi-meta-agent-chat',
    memory: 'michi-meta-agent-memory',
});

const DESCRIPTIONS: Readonly<Record<MetaAgentToolset, string>> = {
    maintenance: 'Michi Meta agent: background maintenance of Space pages',
    chat: 'Michi Meta agent: the Spaces chat window',
    memory: 'Michi Meta agent: automatic memory extraction',
};

const PROMPT = 'You are Michi. Only the michi tools exist: you cannot read or write files, run commands or reach the network.';


/** The agent config Kiro runs a Meta agent session with: Michi's tools in `toolNames` and nothing else. */
export function kiroMetaAgentConfig(toolset: MetaAgentToolset, toolNames: readonly string[]): Record<string, unknown> {
    const names = [...new Set(toolNames)];
    return {
        name: KIRO_META_AGENT_NAMES[toolset],
        description: DESCRIPTIONS[toolset],
        prompt: PROMPT,
        mcpServers: {},
        tools: ['@michi'],
        allowedTools: names.map((name) => `@michi/${name}`),
        toolsSettings: {},
        resources: [],
        hooks: [],
        includeMcpJson: false,
        // No fs_read rule: one puts a builtin read tag in the v3 catalog.
        permissions: { rules: [{ capability: 'mcp', match: names.map((name) => `michi/${name}`), effect: 'allow' }] },
    };
}

/**
 * The working directory of a toolset's kiro-cli: `<data>/meta-agent/kiro/<toolset>`,
 * inside a `.michi` folder to keep its runtime state separate from projects.
 */
export function kiroMetaAgentDir(dataDir: string, toolset: MetaAgentToolset): string {
    const dir = path.join(path.resolve(dataDir), 'meta-agent', 'kiro', toolset);
    return dir.split(path.sep).includes('.michi') ? dir : path.join(dir, '.michi');
}

/** Write (or keep) the toolset's agent config; returns the directory to run kiro-cli in. */
export function ensureKiroMetaAgent(dataDir: string, toolset: MetaAgentToolset, toolNames: readonly string[]): { dir: string; agentName: string } {
    const dir = kiroMetaAgentDir(dataDir, toolset);
    const agentName = KIRO_META_AGENT_NAMES[toolset];
    const agentsDir = path.join(dir, '.kiro', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
    const file = path.join(agentsDir, `${agentName}.json`);
    const text = `${JSON.stringify(kiroMetaAgentConfig(toolset, toolNames), null, 2)}\n`;
    let current: string | null = null;
    try { current = fs.readFileSync(file, 'utf8'); } catch { /* first write */ }
    if (current !== text) {
        const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        fs.writeFileSync(tmp, text, { mode: 0o600 });
        fs.renameSync(tmp, file);
    }
    return { dir, agentName };
}

/** Start the restricted agent with the host environment and deny permission requests. */
export function kiroMetaAgentClientOptions(engine: KiroEngine, agentName: string, env: NodeJS.ProcessEnv = process.env): AcpClientOptions {
    return {
        extraArgs: engine === 'v2' ? ['--agent', agentName] : [],
        childEnv: { ...env },
        rejectPermissions: true,
    };
}

/** v2's `tools` command answer in catalog terms: Michi's tools by name, anything else as `<source>:<name>`. */
export function kiroV2MetaAgentCatalog(response: unknown): string[] {
    const tools = (response as { data?: { tools?: unknown } } | null)?.data?.tools;
    if (!Array.isArray(tools)) return ['(no tool list)'];
    return tools.map((tool) => {
        const name = String((tool as { name?: unknown })?.name ?? '(unnamed)');
        const source = String((tool as { source?: unknown })?.source ?? 'unknown');
        return source === 'mcp:michi' ? name : `${source}:${name}`;
    });
}

/** v3's `_kiro/tools/didChange` tags in catalog terms: `@michi/<tool>` by tool name, anything else as `<source>:<tag>`. */
export function kiroV3MetaAgentCatalog(tags: readonly unknown[]): string[] {
    return tags.map((entry) => {
        const source = String((entry as { source?: unknown })?.source ?? 'unknown');
        const tag = String((entry as { tag?: unknown })?.tag ?? '(untagged)');
        return source === 'mcp' && tag.startsWith('@michi/') && tag.length > '@michi/'.length
            ? tag.slice('@michi/'.length) : `${source}:${tag}`;
    });
}

const hasMichiTag = (state: AcpToolCatalogState | undefined) =>
    !!state?.tags && kiroV3MetaAgentCatalog(state.tags).some((name) => !name.includes(':'));

export interface KiroMetaAgentCatalogCheck {
    client: Pick<AcpClient, 'executeCommand' | 'toolCatalog' | 'waitForToolCatalog'>;
    sessionId: string;
    engine: KiroEngine;
    runtimeId: string;
    profile: RuntimeToolProfile;
    /** v3: the catalog seq before the agent switch; only later catalogs count. */
    sinceSeq?: number;
    timeoutMs?: number;
    /** v3: how long the catalog must stay unchanged before it is checked. */
    settleMs?: number;
}

/**
 * Wait for the catalog Kiro publishes for the selected agent and check it
 * against the profile. Throws MetaAgentGuardError on any extra tool, and when
 * no catalog (or none with a Michi tool) arrives within the timeout.
 */
export async function verifyKiroMetaAgentCatalog(input: KiroMetaAgentCatalogCheck): Promise<string[]> {
    const toolset = metaAgentToolsetOf(input.profile);
    if (!toolset) throw new Error('verifyKiroMetaAgentCatalog needs a Meta agent profile');
    const timeoutMs = input.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(1, deadline - Date.now());
    let observed: string[];
    if (input.engine === 'v2') {
        await input.client.waitForToolCatalog(input.sessionId, (state) => !!state?.initializedServers.includes('michi'), left());
        let response: unknown;
        try {
            response = await input.client.executeCommand(input.sessionId, 'tools', {}, Math.max(5_000, left()));
        } catch (error) {
            throw metaAgentCatalogUnavailable(input.runtimeId, toolset,
                `Kiro did not list its tools: ${error instanceof Error ? error.message : String(error)}`);
        }
        observed = kiroV2MetaAgentCatalog(response);
    } else {
        const since = input.sinceSeq ?? 0;
        const settleMs = input.settleMs ?? 1_000;
        let state = await input.client.waitForToolCatalog(input.sessionId, (s) => (s?.seq ?? 0) > since && hasMichiTag(s), left());
        while (state && state.seq > since && Date.now() < deadline) {
            const seq = state.seq;
            const next = await input.client.waitForToolCatalog(input.sessionId, (s) => (s?.seq ?? 0) > seq, Math.min(settleMs, left()));
            if (!next || next.seq === seq) break;
            state = next;
        }
        if (!state?.tags || state.seq <= since) {
            throw metaAgentCatalogUnavailable(input.runtimeId, toolset, `Kiro published no tool catalog within ${Math.round(timeoutMs / 1000)}s of selecting the agent`);
        }
        observed = kiroV3MetaAgentCatalog(state.tags);
    }
    assertMetaAgentToolCatalog({ runtimeId: input.runtimeId, profile: input.profile, observed });
    const michiTools = new Set(input.profile.allowedToolNames ?? []);
    if (!observed.some((name) => michiTools.has(name))) throw metaAgentCatalogUnavailable(input.runtimeId, toolset, 'Kiro listed none of the Michi tools');
    return observed;
}

export const michiKiroRestrictedAgent = {
    isRestrictedMode: (modeId: string) => Object.values(KIRO_META_AGENT_NAMES).includes(modeId),
    ensure: (dataDir: string, toolset: string, names: readonly string[]) => ensureKiroMetaAgent(dataDir, toolset as MetaAgentToolset, names),
    clientOptions: kiroMetaAgentClientOptions,
    catalog: kiroV3MetaAgentCatalog,

    verify: verifyKiroMetaAgentCatalog,
};
