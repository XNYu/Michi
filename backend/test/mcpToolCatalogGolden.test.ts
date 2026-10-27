/**
 * Golden snapshot of what each kind of Michi slot serves over real HTTP
 * (mountMcp + the SDK's Streamable HTTP client): initialize's serverInfo and
 * capabilities, and every tool object tools/list returns, in wire order.
 * Any change to what an agent sees (a renamed tool, a description or schema
 * field, the session group's routing argument, the order) shows up as a
 * fixture diff.
 *
 * Slot kinds mirror the runtimes' own callbacks: a Kiro chat slot, an Agent
 * Run Attempt (Agent Run tools and submit_agent_result), the Michi assistant,
 * the Kiro shared session-group catalog and a Claude chat slot.
 *
 * Regenerate the fixture only for an intended catalog change:
 *   MICHI_UPDATE_MCP_GOLDEN=1 npm exec -w backend -- node --require ts-node/register --test test/mcpToolCatalogGolden.test.ts
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { closeDb, initDb } from '../src/services/db';
import { McpSlotRegistry, mountMcp, type McpSlotCallbacks } from '../src/services/mcpServer';
import { ensureAssistant } from '../src/assistant/store';
import { ASSISTANT_ALLOWED_TOOL_NAMES } from '../src/assistant/policy';
import { AGENT_RUN_TOOL_NAMES } from '../src/agents/runToolBridge';
import type { ResultBundleV1 } from 'michi-shared';
import { chatOwner, runOwner } from './helpers/owners';

const FIXTURE = path.join(__dirname, 'fixtures', 'mcpToolCatalog.golden.json');

/** Feature flags that change the catalog, pinned so the snapshot does not depend on the machine. */
const PINNED_ENV: Record<string, string | undefined> = {
    MICHI_CLOUD: undefined,
    MICHI_DESK: '1',
    MICHI_SCHEDULED_JOBS: undefined,
    MICHI_WEB_SEARCH_ENABLED: '0',
    MICHI_NODE_SUMMARY_EXPERIMENT_MODE: undefined,
    MICHI_CUSTOM_AGENTS: undefined,
    RAILWAY_PROJECT_ID: undefined,
    RAILWAY_ENVIRONMENT_ID: undefined,
    RAILWAY_SERVICE_ID: undefined,
};

interface ServedCatalog {
    serverInfo: unknown;
    capabilities: unknown;
    /** Tool objects exactly as tools/list returned them. */
    tools: Array<{ name: string } & Record<string, unknown>>;
}

const savedEnv = new Map<string, string | undefined>();
let dataDir: string;
let server: Server;
let baseUrl: string;
const registry = new McpSlotRegistry();

before(async () => {
    savedEnv.set('MICHI_DATA_DIR', process.env.MICHI_DATA_DIR);
    for (const key of Object.keys(PINNED_ENV)) savedEnv.set(key, process.env[key]);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-mcp-golden-'));
    process.env.MICHI_DATA_DIR = dataDir;
    for (const [key, value] of Object.entries(PINNED_ENV)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    closeDb();
    initDb();
    const app = express();
    app.use(express.json());
    const router = express.Router();
    mountMcp(router, registry);
    app.use('/api', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
    for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

async function listCatalog(route: string): Promise<ServedCatalog> {
    const client = new Client({ name: 'michi-mcp-golden', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}${route}`)));
    try {
        const { tools } = await client.listTools();
        return JSON.parse(JSON.stringify({
            serverInfo: client.getServerVersion(),
            capabilities: client.getServerCapabilities(),
            tools,
        })) as ServedCatalog;
    } finally {
        await client.close();
    }
}

const noAnswer = async () => null;

/** The callbacks KiroRuntime.makeSlotCallbacks gives a chat slot. */
function kiroChatCallbacks(): McpSlotCallbacks {
    return {
        onSpawnBranches: async () => [],
        onSaveArtifact: () => null,
        onUpdateArtifact: () => null,
        onSetFollowUps: () => {},
        onSetBranchOverview: () => {},
        metadataDoneSentinel: '<michi-metadata-done/>',
        onAskUser: noAnswer,
    };
}

/** The callbacks ClaudeSession gives a chat slot with the follow-ups hook experiment on. */
function claudeChatCallbacks(): McpSlotCallbacks {
    return {
        owner: chatOwner('n-claude'),
        onSpawnBranches: async () => [],
        onSaveArtifact: () => null,
        onUpdateArtifact: () => null,
        onShowImage: () => ({ error: 'unsupported in test' }),
        onSetFollowUps: () => {},
        onSetBranchOverview: () => {},
        onValidateFollowUps: () => ({}),
        onAskUser: noAnswer,
        agentRunToolNames: [...AGENT_RUN_TOOL_NAMES],
    };
}

async function snapshot(): Promise<Record<string, ServedCatalog>> {
    const chat = registry.create('kiro-chat', dataDir, null, kiroChatCallbacks(), { nodeId: 'n-chat', workspaceId: 'ws-chat' });

    const run = registry.create('run-attempt', dataDir, null, {
        owner: runOwner('run-1', 'attempt-1'),
        exposedToolNames: new Set([
            'michi_docs', 'save_artifact', 'list_threads', 'read_node', 'search_messages', 'inspect_pane',
            'read_pane_output', 'ask_user', ...AGENT_RUN_TOOL_NAMES, 'submit_agent_result',
        ]),
        onSpawnBranches: async () => [],
        onSaveArtifact: () => null,
        onUpdateArtifact: () => null,
        onAskUser: noAnswer,
        agentRuns: { invoke: async () => ({}) },
        agentRunToolNames: [...AGENT_RUN_TOOL_NAMES],
        onSubmitAgentResult: () => ({}) as ResultBundleV1,
    }, { nodeId: null, workspaceId: 'ws-run' });

    const assistant = ensureAssistant();
    const assistantSlot = registry.create(assistant.nodeId, dataDir, null, {
        ...claudeChatCallbacks(),
        owner: chatOwner(assistant.nodeId),
        restricted: true,
        exposedToolNames: new Set(ASSISTANT_ALLOWED_TOOL_NAMES),
        isServing: () => true,
    }, { nodeId: assistant.nodeId, workspaceId: assistant.workspaceId });

    // KiroRuntime.chatMcpServer: the shared catalog is a copy of the warm
    // slot with a catalog-only Agent Run invoker when Custom Agents are on.
    const warm = registry.create('__pending__', dataDir, null, kiroChatCallbacks());
    const group = registry.createSessionGroup({
        ...warm,
        agentRuns: { invoke: async () => { throw new Error('MCP catalog cannot execute tools'); } },
    });

    const claude = registry.create('claude-chat', dataDir, null, claudeChatCallbacks(), { nodeId: 'n-claude', workspaceId: 'ws-chat' });

    return {
        kiroChat: await listCatalog(`/mcp/${chat.slotId}`),
        agentRun: await listCatalog(`/mcp/${run.slotId}`),
        assistant: await listCatalog(`/mcp/${assistantSlot.slotId}`),
        kiroSessionGroup: await listCatalog(`/mcp-session/${group}`),
        claudeChat: await listCatalog(`/mcp/${claude.slotId}`),
    };
}

test('every slot kind serves exactly the golden MCP tool catalog', async () => {
    const actual = await snapshot();
    const text = `${JSON.stringify(actual, null, 2)}\n`;
    if (process.env.MICHI_UPDATE_MCP_GOLDEN === '1') {
        fs.writeFileSync(FIXTURE, text);
        return;
    }
    assert.ok(fs.existsSync(FIXTURE), `missing ${FIXTURE}; run with MICHI_UPDATE_MCP_GOLDEN=1 to create it`);
    for (const [kind, served] of Object.entries(actual)) assert.ok(served.tools.length > 0, `${kind} lists tools`);
    assert.deepEqual(JSON.parse(text), JSON.parse(fs.readFileSync(FIXTURE, 'utf8')));
});
