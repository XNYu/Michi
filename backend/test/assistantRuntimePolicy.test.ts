import { restrictedChatProfile } from './helpers/restrictedChatProfile';

/**
 * How each runtime keeps the Michi assistant from working as a worker
 * (assistant/policy.ts): Claude's Agent SDK options, PreToolUse hook /
 * canUseTool verdicts and init check, Codex's read-only turns and declined
 * approvals and Pi's tool set (Kiro and Crew: kiroMetaAgent.test.ts). No real CLI
 * runs: Claude's SDK transport (helpers/claudeSdkFixture) and Codex's
 * app-server client are stubs. The SDK's own argv for these options is
 * checked in claudeSdkTransport.test.ts.
 */

import './helpers/claudeSdkFixture';
import { after, afterEach, before, beforeEach, describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { claudeTestOptions } from './helpers/claudeTestOptions';
import { EventEmitter, PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MICHI_ASSISTANT_MARKER } from 'michi-shared';
import {
  ASSISTANT_ALLOWED_TOOL_NAMES,
  ASSISTANT_CHANNEL_TOOL_NAMES,
  ASSISTANT_INSTRUCTIONS,
  CLAUDE_ASSISTANT_DISALLOWED_TOOLS,
  CODEX_ASSISTANT_TURN_POLICY,
  CODEX_MICHI_MCP_SERVER,
  CODEX_META_AGENT_UNREMOVABLE_TOOLS,
  META_AGENT_CHAT_TOOL_NAMES,
  TURN_METADATA_TOOL_NAMES,
  assistantRuntimeRefusal,
  assistantToolProfile,
  claudeAssistantApproval,
  claudeSpawnPolicy,
  codexAssistantApproval,
  codexAssistantMcpCheck,
  codexAssistantThreadConfig,
  codexMetaAgentCatalog,
  codexThreadSandbox,
  isAssistantAllowedTool,
  piAssistantToolDecision,
} from '../src/assistant/policy';
import {
  MICHI_INTERNAL_MCP_NAME, MICHI_MCP_TOOL_PREFIX, claudeInitCatalog, claudeLacksRestrictedFlag, claudeLacksToolsFlag, michiMcpToolName,
  unexpectedClaudeInitServers,
} from 'michi-runtime/internal/adapters/claude/claudeMcpConfig';
import { MetaAgentGuardError, checkMetaAgentToolCatalog } from '../src/agents/metaAgentGuard';
import { META_AGENT_MAINTENANCE_TOOL_NAMES, maintenanceToolProfile } from '../src/agents/maintenancePolicy';
import { SCHEDULED_JOB_TOOL_NAMES } from '../src/agents/scheduledJobToolNames';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { buildPiTools } from '../src/agents/pi/piTools';
import { CodexRuntime } from 'michi-runtime/internal/adapters/codex/CodexRuntime';
import type { CodexSession } from 'michi-runtime/internal/adapters/codex/CodexSession';
import { CODEX_SERVER_REQUESTS } from 'michi-runtime/internal/adapters/codex/codexProtocol';
import { closeDb, initDb } from '../src/services/db';
import { saveWorkspace } from '../src/services/dbRepository';
import { ensureAssistant, ensureAssistantFor } from '../src/assistant/store';
import { SCHEDULE_ASSISTANT_TOOL_NAMES } from '../src/assistant/policy';
import { michiTestHost } from './helpers/michiTestHost';
import { fakeMcpRegistry } from './helpers/fakeMcpRegistry';
import type { McpSlotProvider } from 'michi-runtime/internal/contract/mcp';
import { chatOwner, runOwner } from './helpers/owners';
import { codexTestOptions } from './helpers/codexTestOptions';

/**
 * The init the real Claude Code 2.1.305 sent an assistant session started by
 * Michi's ClaudeRuntime (offline; paths and ids scrubbed), and the envelopes
 * before it. See fixtures/claude-2.1.305-assistant-init.json. It was recorded
 * while Michi's MCP slot still served an `approve` tool, since removed; the
 * catalog's init today lists everything else.
 */
const RECORDED_ASSISTANT_INIT = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-2.1.305-assistant-init.json'), 'utf8')) as {
  preInit: Array<Record<string, unknown>>; init: Record<string, unknown>;
};
/** The Agent Desk tools the assistant had when the init was recorded. */
const LEGACY_DESK_TOOLS = ['desk_now', 'desk_search_threads', 'desk_peek', 'desk_archive_threads', 'desk_ignore_threads', 'desk_unarchive_threads', 'desk_mark_done', 'desk_undo'];
/** The recorded catalog predates the current assistant toolset. */
const REAL_ASSISTANT_INIT: typeof RECORDED_ASSISTANT_INIT = {
  ...RECORDED_ASSISTANT_INIT,
  init: {
    ...RECORDED_ASSISTANT_INIT.init,
    tools: (RECORDED_ASSISTANT_INIT.init.tools as string[])
      .filter((tool) => tool !== `mcp____michi_internal____send_to_thread`
        && tool !== `mcp____michi_internal____approve`
        && ![...LEGACY_DESK_TOOLS, ...TURN_METADATA_TOOL_NAMES].some((name) => tool === `mcp____michi_internal____${name}`)),
  },
};

const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null } as any;
const store = { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null };
const agentConfig = { getAgentConfig: () => ({ runtime: 'claude', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => '', resolveReasoning: () => undefined };

/** Every chat in these tests is in YOLO mode, the strongest permission a user can give. */
function configureYolo(): void {
  configureRuntimeDeps({
    historyStore: store as any, agentConfig, dataDir: path.join(os.tmpdir(), 'assistant-policy-runtime'),
    chatPermissions: { getMode: () => 'yolo', hasGrant: () => false, grant: () => {} },
  });
}

describe('policy decisions', () => {
  test('interactive Assistant uses ordinary native tools and permission mode', () => {
    assert.deepEqual(assistantToolProfile(), { assistant: true });
    assert.deepEqual(claudeSpawnPolicy({ ownerMode: 'interactive', permissionMode: 'ask', toolProfile: assistantToolProfile() }), { permissionMode: 'default' });
    assert.deepEqual(claudeSpawnPolicy({ ownerMode: 'interactive', permissionMode: 'yolo', toolProfile: assistantToolProfile() }), { permissionMode: 'bypassPermissions' });
    assert.equal(codexThreadSandbox(assistantToolProfile()), 'workspace-write');
    assert.equal(codexThreadSandbox(maintenanceToolProfile()), 'read-only');
  });
  test('Claude: the assistant never bypasses, has no built-in tools and loads only Michi MCP', () => {
    const assistant = claudeSpawnPolicy({ ownerMode: 'interactive', permissionMode: 'yolo', toolProfile: restrictedChatProfile() });
    assert.equal(assistant.permissionMode, 'default');
    assert.equal(assistant.strictMcpConfig, true);
    assert.equal(assistant.isolateSettings, true, 'none of the user\'s settings, hooks, plugins or skills');
    assert.deepEqual(assistant.tools, [], 'no built-in tool at all: headless mode would run them without asking');
    assert.equal(assistant.restrictedMode, true, 'and the CLI\'s own --restricted');
    // Every built-in an ordinary Claude Code 2.1.305 session reports at init, and the
    // ones a CLI ignoring --tools could still offer (Read could reach Michi's token file).
    const ordinaryInit2_1_305 = ['Task', 'AskUserQuestion', 'Bash', 'CronCreate', 'CronDelete', 'CronList', 'Edit',
      'EnterPlanMode', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree', 'ListAgents', 'NotebookEdit', 'Read',
      'ReportFindings', 'ScheduleWakeup', 'SendMessage', 'Skill', 'TaskStop', 'ToolSearch', 'WebFetch', 'WebSearch',
      'Workflow', 'Write'];
    for (const tool of [...ordinaryInit2_1_305, 'Glob', 'Grep', 'NotebookRead', 'TodoWrite', 'TaskOutput', 'MultiEdit',
      'ListMcpResourcesTool', 'ReadMcpResourceTool', 'Agent', 'BashOutput', 'KillShell', 'PowerShell']) {
      assert.ok(assistant.disallowedTools?.includes(tool), `${tool} is also denied`);
    }
    assert.ok(assistant.disallowedTools?.every((tool) => !tool.startsWith('mcp__')), 'no Michi tool is denied');

    assert.deepEqual(claudeSpawnPolicy({ ownerMode: 'interactive', permissionMode: 'yolo', toolProfile: undefined }), { permissionMode: 'bypassPermissions' });
    assert.deepEqual(claudeSpawnPolicy({ ownerMode: 'interactive', permissionMode: 'ask', toolProfile: undefined }), { permissionMode: 'default' });
    assert.deepEqual(claudeSpawnPolicy({ ownerMode: 'headless', permissionMode: 'yolo', toolProfile: { allowedToolNames: [] } }), { permissionMode: 'default' });
    assert.deepEqual(claudeSpawnPolicy({ ownerMode: 'interactive', permissionMode: 'yolo', toolProfile: { allowedToolNames: ['read'] } }), { permissionMode: 'default' },
      'a restricted profile never bypasses either');

    assert.equal(claudeAssistantApproval('list_workspaces'), 'allow');
    assert.equal(claudeAssistantApproval('read_page'), 'allow');
    assert.equal(claudeAssistantApproval('desk_archive_threads'), 'deny', 'the Michi tools are gone');
    assert.equal(claudeAssistantApproval('save_artifact'), 'deny');
    assert.equal(claudeAssistantApproval(null), 'deny', 'native tools are never approved for the assistant');
  });

  test('Claude names Michi MCP tools by prefix; michiMcpToolName recovers the bare name', () => {
    assert.equal(michiMcpToolName('mcp____michi_internal____list_threads'), 'list_threads');
    assert.equal(michiMcpToolName('mcp__slack__post'), null);
    assert.equal(michiMcpToolName('Bash'), null);
  });

  test('Claude init: only the allowed Michi tools may be reported; no list fails closed', () => {
    const allowed = ['list_workspaces', 'read_node'];
    const michi = (name: string) => `${MICHI_MCP_TOOL_PREFIX}${name}`;
    const safe = { mcp_servers: [{ name: MICHI_INTERNAL_MCP_NAME }], permissionMode: 'default' };
    const unexpected = (tools: unknown) => checkMetaAgentToolCatalog({
      runtimeId: 'claude', toolset: 'chat', allowed, observed: claudeInitCatalog({ ...safe, tools }),
    })?.unexpectedTools ?? [];
    assert.deepEqual(claudeInitCatalog({ ...safe, tools: [michi('list_workspaces'), 'Bash'] }), ['list_workspaces', 'native:Bash']);
    assert.deepEqual(unexpected([michi('list_workspaces'), michi('read_node')]), []);
    assert.deepEqual(unexpected([]), [], 'fewer tools is not unsafe');
    assert.deepEqual(
      unexpected([michi('list_workspaces'), 'Bash', michi('save_artifact'), 'mcp__slack__post', 'ToolSearch']),
      ['native:Bash', 'native:ToolSearch', 'native:mcp__slack__post', 'save_artifact'],
    );
    assert.deepEqual(unexpected(undefined), ['(no tool list)']);
    assert.deepEqual(unexpected('Bash'), ['(no tool list)']);
    // Only Michi's own MCP server; a missing list fails closed too.
    assert.deepEqual(unexpectedClaudeInitServers([{ name: MICHI_INTERNAL_MCP_NAME, status: 'connected' }]), []);
    assert.deepEqual(unexpectedClaudeInitServers([{ name: MICHI_INTERNAL_MCP_NAME, status: 'failed' }]), [], 'a failed Michi server is not unsafe');
    assert.deepEqual(unexpectedClaudeInitServers([{ name: MICHI_INTERNAL_MCP_NAME }, { name: 'slack', status: 'connected' }]), ['MCP server slack']);
    assert.deepEqual(unexpectedClaudeInitServers(undefined), ['(no MCP server list)']);
  });

  test("Claude 2.1.305's real assistant init passes the init check; any widening fails it", () => {
    const init = REAL_ASSISTANT_INIT.init;
    assert.equal(init.permissionMode, 'default');
    assert.deepEqual((init.mcp_servers as Array<{ name: string }>).map((s) => s.name), [MICHI_INTERNAL_MCP_NAME]);
    for (const tool of ['ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'Read', 'Bash']) {
      assert.ok(!(init.tools as string[]).includes(tool), `${tool} is not reported`);
    }
    const violations = (envelope: Record<string, unknown>) => checkMetaAgentToolCatalog({
      runtimeId: 'claude', toolset: 'chat', allowed: ASSISTANT_ALLOWED_TOOL_NAMES, observed: claudeInitCatalog(envelope),
    })?.unexpectedTools ?? [];
    assert.deepEqual(violations(init), []);
    const widened: Array<[string, Record<string, unknown>]> = [
      ['a built-in tool', { ...init, tools: [...(init.tools as string[]), 'Read'] }],
      ['a Michi tool outside the list', { ...init, tools: [...(init.tools as string[]), `${MICHI_MCP_TOOL_PREFIX}save_artifact`] }],
      ['the MCP resource tools', { ...init, tools: [...(init.tools as string[]), 'ListMcpResourcesTool', 'ReadMcpResourceTool'] }],
      ['another MCP server', { ...init, mcp_servers: [...(init.mcp_servers as unknown[]), { name: 'slack', status: 'connected' }] }],
      ['no permission mode', (({ permissionMode: _mode, ...rest }) => rest)(init)],
      ['bypassPermissions', { ...init, permissionMode: 'bypassPermissions' }],
    ];
    for (const [label, envelope] of widened) assert.notDeepEqual(violations(envelope), [], label);
    assert.deepEqual(violations({ ...init, tools: [...(init.tools as string[]), `${MICHI_MCP_TOOL_PREFIX}send_to_thread`] }), ['send_to_thread'],
      'the chat toolset no longer has send_to_thread');
    assert.deepEqual(violations(RECORDED_ASSISTANT_INIT.init), [...LEGACY_DESK_TOOLS, 'approve', 'send_to_thread'].sort(),
      'the init as recorded, with the Michi tools, now fails the check');
  });

  test('Claude: an install without --restricted is recognised from its stderr', () => {
    assert.ok(claudeLacksRestrictedFlag("error: unknown option '--restricted'"));
    assert.ok(!claudeLacksRestrictedFlag("error: unknown option '--restricted-mode'"));
    assert.ok(!claudeLacksRestrictedFlag('Restricted mode: removes the built-in tools'));
  });

  test('Claude: an install without --tools is recognised from its stderr', () => {
    assert.ok(claudeLacksToolsFlag("error: unknown option '--tools='"), 'the SDK passes --tools=<list>');
    assert.ok(claudeLacksToolsFlag("error: unknown option '--tools'"));
    assert.ok(claudeLacksToolsFlag('Error: Unknown option --tools'));
    assert.ok(!claudeLacksToolsFlag("error: unknown option '--toolsets'"));
    assert.ok(!claudeLacksToolsFlag('Using --tools ""'));
  });

  test('Codex: read-only, offline turns; read-only threads; every approval declined', () => {
    assert.deepEqual(CODEX_ASSISTANT_TURN_POLICY, { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
    assert.equal(codexThreadSandbox(restrictedChatProfile()), 'read-only');
    assert.equal(codexThreadSandbox(undefined), 'workspace-write');
    assert.equal(codexAssistantApproval(), 'decline');
  });

  test('Codex: the thread config turns off shell, plugins and every MCP server but Michi\'s', () => {
    const michi = { url: 'http://127.0.0.1:1/api/mcp/s', headers: [], default_tools_approval_mode: 'approve' };
    const base = { mcp_servers: { [CODEX_MICHI_MCP_SERVER]: michi }, features: { hooks: true }, hooks: { Stop: [] } };
    const config = codexAssistantThreadConfig(base, ['asana-mcp', 'node_repl', CODEX_MICHI_MCP_SERVER]);
    assert.deepEqual(config.mcp_servers, {
      'asana-mcp': { enabled: false },
      node_repl: { enabled: false },
      [CODEX_MICHI_MCP_SERVER]: michi,
    }, 'Michi\'s own server is never disabled, the user\'s always are');
    const features = config.features as Record<string, unknown>;
    assert.equal(features.hooks, true, 'Michi\'s hook feature is kept');
    for (const feature of [
      'shell_tool', 'unified_exec', 'js_repl', 'js_repl_tools_only', 'code_mode', 'code_mode_only', 'code_mode_host',
      'apply_patch_freeform', 'plugins', 'apps', 'browser_use', 'computer_use', 'multi_agent', 'image_generation',
    ]) {
      assert.equal(features[feature], false, feature);
    }
    assert.equal(config.web_search, 'disabled');
    assert.ok(!('include_apply_patch_tool' in config), 'not a Codex key: the freeform apply_patch feature is the switch');
    assert.deepEqual(config.hooks, { Stop: [] });
    assert.deepEqual(base.features, { hooks: true }, 'the base config is not mutated');
  });

  test('Codex: a started thread passes only with Michi\'s server and every other one disabled', () => {
    const michi = { name: CODEX_MICHI_MCP_SERVER, runtimeStatus: 'connected' };
    assert.deepEqual(codexAssistantMcpCheck([michi, { name: 'asana-mcp', runtimeStatus: 'disabled' }]), { ok: true });
    const open = codexAssistantMcpCheck([
      michi,
      { name: 'asana-mcp', runtimeStatus: 'disabled' },
      { name: 'late-server', runtimeStatus: 'starting' },
      { name: 'broken', runtimeStatus: 'failed' },
      { name: 'unknown', runtimeStatus: null },
    ]);
    assert.equal(open.ok, false);
    assert.ok(!open.ok && !open.fatal);
    assert.deepEqual(!open.ok && open.open, ['late-server', 'broken', 'unknown'], 'anything not disabled counts as open');
    const unlisted = codexAssistantMcpCheck(null);
    assert.ok(!unlisted.ok && unlisted.fatal && /did not list/.test(unlisted.reason), 'an answer without a list fails closed');
    const empty = codexAssistantMcpCheck([]);
    assert.ok(!empty.ok && empty.fatal && /Michi's own MCP server is missing/.test(empty.reason),
      'an empty list is not proof: Michi\'s own server must be there');
    const noMichi = codexAssistantMcpCheck([{ name: 'asana-mcp', runtimeStatus: 'disabled' }]);
    assert.ok(!noMichi.ok && noMichi.fatal);
  });

  test('Pi: only the assistant tools exist and run', () => {
    for (const name of ASSISTANT_ALLOWED_TOOL_NAMES) assert.equal(piAssistantToolDecision(name), 'allow');
    for (const name of ['bash', 'write', 'edit', 'read', 'save_artifact', 'spawn_branches', 'web_search', 'mcp_user_tool']) {
      assert.equal(piAssistantToolDecision(name), 'block', name);
    }
  });

  test('Crew cannot host the assistant; Claude, Codex, Pi and Kiro can', () => {
    assert.match(assistantRuntimeRefusal('crew') ?? '', /Kiro Crew/);
    for (const id of ['claude', 'codex', 'pi', 'kiro']) assert.equal(assistantRuntimeRefusal(id), null, id);
  });

  test('the chat toolset is the assistant catalog without send_to_thread, plus updates, Pages and a new conversation', () => {
    assert.ok(!ASSISTANT_ALLOWED_TOOL_NAMES.includes('send_to_thread'));
    for (const name of ['read_conversation_updates', 'read_page', 'edit_page', 'create_page', 'layout_rules', 'start_conversation', 'list_threads', 'ask_user']) {
      assert.ok(ASSISTANT_ALLOWED_TOOL_NAMES.includes(name), name);
    }
    for (const name of LEGACY_DESK_TOOLS) assert.ok(!ASSISTANT_ALLOWED_TOOL_NAMES.includes(name), `${name} reads or writes Agent Desk`);
    for (const name of TURN_METADATA_TOOL_NAMES) assert.ok(!ASSISTANT_ALLOWED_TOOL_NAMES.includes(name), `${name} belongs to ordinary chats`);
    for (const name of ['bash', 'shell', 'write', 'fs_write', 'web_search', 'save_artifact', 'create_scheduled_job']) {
      assert.ok(!ASSISTANT_ALLOWED_TOOL_NAMES.includes(name), name);
    }
    assert.equal(claudeAssistantApproval('send_to_thread'), 'deny');
    assert.deepEqual(restrictedChatProfile(), { allowedToolNames: ASSISTANT_ALLOWED_TOOL_NAMES, assistant: true, restricted: true, metaAgentToolset: 'chat' });
  });
});

describe('Pi assistant session tools', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-pi-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    configureRuntimeDeps({ historyStore: store as any, agentConfig, dataDir: path.join(os.tmpdir(), 'assistant-policy-runtime') });
  });
  afterEach(() => {
    __resetRuntimeDeps();
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function piToolNames(nodeId: string, workspaceId: string): string[] {
    const Type: any = new Proxy({}, { get: () => (..._a: any[]) => ({}) });
    return buildPiTools({
      bridge, cwd: '/tmp', parentChatId: nodeId, workspaceId, enableFollowUps: true,
      imageQuota: { usedBytes: 0, limitBytes: 1 } as any, seenPaths: new Set(), Type,
      owner: chatOwner(nodeId), toolProfile: restrictedChatProfile(),
    }).map((tool: any) => tool.name);
  }

  test('interactive Assistant retains native tools alongside its cross-workspace Page tools', () => {
    const info = ensureAssistant();
    const Type: any = new Proxy({}, { get: () => (..._a: any[]) => ({}) });
    const names = buildPiTools({ bridge, cwd: '/tmp', parentChatId: info.nodeId, workspaceId: info.workspaceId,
      enableFollowUps: false, imageQuota: { usedBytes: 0, limitBytes: 1 } as any, seenPaths: new Set(), Type,
      owner: chatOwner(info.nodeId), toolProfile: assistantToolProfile(),
    }).map((tool: any) => tool.name);
    for (const name of ['bash', 'read', 'write', 'edit', 'list_workspaces', 'edit_page', 'start_conversation']) assert.ok(names.includes(name), name);
    assert.equal(new Set(names).size, names.length);
  });

  test('the Scheduled window on Pi keeps native tools beside its own catalog, and no other Michi tools', () => {
    const info = ensureAssistantFor('schedule');
    const Type: any = new Proxy({}, { get: () => (..._a: any[]) => ({}) });
    const names = buildPiTools({ bridge, cwd: '/tmp', parentChatId: info.nodeId, workspaceId: info.workspaceId,
      enableFollowUps: false, imageQuota: { usedBytes: 0, limitBytes: 1 } as any, seenPaths: new Set(), Type,
      owner: chatOwner(info.nodeId), toolProfile: assistantToolProfile(),
    }).map((tool: any) => tool.name);
    const native = ['read', 'ls', 'grep', 'find', 'write', 'edit', 'bash', 'web_search'];
    for (const name of ['bash', 'read', 'write', 'edit']) assert.ok(names.includes(name), name);
    assert.deepEqual(names.filter((name) => !native.includes(name)).sort(),
      SCHEDULE_ASSISTANT_TOOL_NAMES.filter((name) => !(ASSISTANT_CHANNEL_TOOL_NAMES as readonly string[]).includes(name)).sort());
    assert.equal(new Set(names).size, names.length);
  });

  test('buildPiTools offers exactly the chat-window catalog, no native tools', () => {
    const info = ensureAssistant();
    const userChannels = [...ASSISTANT_CHANNEL_TOOL_NAMES, ...TURN_METADATA_TOOL_NAMES] as readonly string[];
    assert.deepEqual(piToolNames(info.nodeId, info.workspaceId).sort(),
      META_AGENT_CHAT_TOOL_NAMES.filter((name) => !userChannels.includes(name)).sort());
    assert.ok(!piToolNames(info.nodeId, info.workspaceId).includes('send_to_thread'));
  });



  test('an assistant profile outside the assistant\'s workspace gets no tools at all', () => {
    ensureAssistant();
    saveWorkspace({ id: 'ws-a', name: 'A', created_at: 1, updated_at: 1, settings: null });
    assert.deepEqual(piToolNames('n-a', 'ws-a'), []);
  });

  test("the assistant's Pi preamble advertises none of the ordinary chat tools", async (t) => {
    const sdk = require('../src/agents/pi/PiSdkSession');
    const preambles: string[] = [];
    t.mock.method(sdk, 'createPiSession', async (id: string, deps: { preamble: string }) => {
      preambles.push(deps.preamble);
      return { id, runtimeId: 'pi', destroy() {}, getHistory: () => [], getPendingAssistant: () => undefined } as any;
    });
    const { PiRuntime } = require('../src/agents/pi/PiRuntime') as typeof import('../src/agents/pi/PiRuntime');
    const runtime = new PiRuntime(bridge);
    const info = ensureAssistant();
    await runtime.newSession({ sessionId: info.nodeId, cwd: tmpDir, workspaceId: info.workspaceId, toolProfile: restrictedChatProfile(), bootstrapInstructions: ASSISTANT_INSTRUCTIONS } as any);
    await runtime.loadSession({ sessionId: 'n-assistant-old', cwd: tmpDir, workspaceId: info.workspaceId, toolProfile: restrictedChatProfile() } as any);
    await runtime.newSession({ sessionId: 'n-plain', cwd: tmpDir, workspaceId: 'ws-a' } as any);
    assert.equal(preambles.length, 3);
    for (const preamble of preambles.slice(0, 2)) {
      for (const pattern of [/save_artifact/, /spawn_branches/, /_scheduled_job/, /spawn_agent/, /`bash`/]) assert.doesNotMatch(preamble, pattern);
      assert.match(preamble, /Michi assistant's own/);
    }
    assert.match(preambles[2], /save_artifact/, 'ordinary chats keep their guidance');
  });
});

// ── Claude session ──────────────────────────────────────────────────────────

class MockClaudeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  // No pid: process-tree cleanup must never signal a real process from a test.
  killed = false;
  /** Like a busy CLI: SIGINT is ignored, only SIGKILL ends it. */
  ignoreSigint = false;
  kill(signal?: string): boolean {
    this.killed = true;
    if (this.ignoreSigint && signal !== 'SIGKILL') return true;
    process.nextTick(() => this.emit('exit', signal === 'SIGKILL' ? 137 : 0, null));
    return true;
  }
  /** `tools: null` leaves the list out of the envelope; `extra` adds mcp_servers / permissionMode. */
  emitInit(sessionId: string, tools: readonly string[] | null, extra: Record<string, unknown> = {}): void {
    this.stdout.push(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, ...(tools ? { tools } : {}), ...extra }) + '\n');
  }
}

/** What a current Claude Code reports for these spawn flags: with `--tools ""`, only the MCP tools. */
function initToolsFor(args: { tools?: readonly string[] }): string[] {
  const michi = ASSISTANT_ALLOWED_TOOL_NAMES.map((name) => `${MICHI_MCP_TOOL_PREFIX}${name}`);
  return args.tools ? [...args.tools, ...michi] : ['Bash', 'Edit', 'Read', ...michi];
}

describe('Claude assistant session', () => {
  let tmpDir: string;
  const spawned: any[] = [];
  const children: MockClaudeChild[] = [];
  /**
   * Replaces the init tool list, MCP server list (null leaves either out) or
   * permission mode (an older or misbehaving CLI), or writes stderr instead of init.
   * withholdInit sends no init; outputBeforeInit answers first; slowExit ignores SIGINT.
   */
  let misbehave: {
    tools?: string[] | null; servers?: string[] | null; permissionMode?: string; stderr?: string;
    withholdInit?: boolean; outputBeforeInit?: boolean; slowExit?: boolean;
  } | null = null;
  const binary = require('michi-runtime/internal/adapters/claude/claudeBinary');
  const original = { spawn: binary.spawnClaude, preflight: binary.preflightClaudeAuth };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-claude-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    configureYolo();
    spawned.length = 0;
    children.length = 0;
    misbehave = null;
    binary.preflightClaudeAuth = () => {};
    // The SDK fixture hands the transport options to spawnClaude.
    binary.spawnClaude = (args: { tools?: readonly string[]; permissionMode?: string }) => {
      spawned.push(args);
      const child = new MockClaudeChild();
      children.push(child);
      const fault = misbehave;
      if (fault?.slowExit) child.ignoreSigint = true;
      setTimeout(() => {
        if (fault?.stderr) { child.stderr.push(fault.stderr); return; }
        if (fault?.withholdInit) return;
        if (fault?.outputBeforeInit) {
          child.stdout.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }) + '\n');
        }
        const servers = fault && 'servers' in fault ? fault.servers : [MICHI_INTERNAL_MCP_NAME];
        child.emitInit(`ext-${spawned.length}`, fault && 'tools' in fault ? fault.tools ?? null : initToolsFor(args), {
          ...(servers ? { mcp_servers: servers.map((name) => ({ name, status: 'connected' })) } : {}),
          permissionMode: fault?.permissionMode ?? args.permissionMode,
        });
      }, 10);
      return child;
    };
  });

  afterEach(() => {
    binary.spawnClaude = original.spawn;
    binary.preflightClaudeAuth = original.preflight;
    __resetRuntimeDeps();
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  test('interactive Assistant starts Claude with native tools and user settings', async () => {
    const { session } = await spawn('n-unrestricted', assistantToolProfile());
    try {
      assert.equal((session as any).sdkBuiltinTools(), undefined);
      assert.equal((session as any).isToolAllowed('Bash'), true);
      assert.equal((session as any).isToolAllowed('mcp__user_server__tool'), true);
    } finally { await session.dispose(); }
  });

  /** The init a well-behaved CLI reports for the given spawn. */
  function goodInit(child: MockClaudeChild, args: { tools?: readonly string[]; permissionMode?: string }): void {
    child.emitInit('ext-late', initToolsFor(args), {
      mcp_servers: [{ name: MICHI_INTERNAL_MCP_NAME, status: 'connected' }], permissionMode: args.permissionMode,
    });
  }

  async function spawn(id: string, toolProfile?: ReturnType<typeof assistantToolProfile>) {
    const { ClaudeSession } = require('michi-runtime/internal/adapters/claude/ClaudeSession') as typeof import('michi-runtime/internal/adapters/claude/ClaudeSession');
    const callbacks: any[] = [];
    const mcpRegistry = {
      create: (_p: string, _c: string, _o: string | null, cbs: unknown) => { callbacks.push(cbs); return { slotId: `slot-${callbacks.length}` }; },
      dispose: async () => {},
      endpoint: (slotId: string) => ({ type: 'http' as const, url: `http://127.0.0.1:3000/api/mcp/${slotId}`, headers: [] }),
    };
    const session = new ClaudeSession(id, {
      options: claudeTestOptions(),
      nodeId: id, cwd: tmpDir, workspaceId: null, mcpRegistry: mcpRegistry as any, bridge,
      // No node rows here: only the init check may stop the process.
      persistNativeIdentity: false,
      ...(toolProfile ? { toolProfile } : {}),
    } as any);
    await session.spawnFresh();
    return { session, slot: callbacks[0], onApprove: (session as any).makeOnApprove() as (p: { toolName: string; input: unknown; toolUseId: string }) => Promise<any> };
  }

  /** The text of the first message a ClaudeRuntime session writes to the CLI. */
  async function firstClaudeMessage(id: string, extra: Record<string, unknown>): Promise<string> {
    const { ClaudeRuntime } = require('michi-runtime/internal/adapters/claude/ClaudeRuntime') as typeof import('michi-runtime/internal/adapters/claude/ClaudeRuntime');
    const mcpRegistry = { create: () => ({ slotId: `slot-${id}` }), dispose: async () => {}, get: () => undefined, endpoint: (slotId: string) => ({ type: 'http' as const, url: `http://127.0.0.1:3000/api/mcp/${slotId}`, headers: [] }), };
    const runtime = new ClaudeRuntime({ ...claudeTestOptions(), bridge, mcpSlots: mcpRegistry as any });
    const written: string[] = [];
    let turn: Promise<unknown> | undefined;
    try {
      const session = await runtime.newSession({ sessionId: id, cwd: tmpDir, profileHash: `hash-${id}`, ...extra } as any);
      children[children.length - 1].stdin.on('data', (chunk: Buffer) => { written.push(chunk.toString()); });
      turn = session.send('What is waiting?')[Symbol.asyncIterator]().next().catch(() => undefined);
      for (let i = 0; i < 100 && !written.join('').includes('What is waiting?'); i += 1) await new Promise((r) => setTimeout(r, 5));
    } finally {
      await runtime.shutdown();
      await turn;
    }
    const envelope = written.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      .find((e) => e.type === 'user' && e.shouldQuery !== false);
    const content = envelope.message.content;
    return typeof content === 'string' ? content : content.find((b: any) => b.type === 'text').text;
  }

  test("an assistant conversation's first message opens with the marker, ahead of any context Michi adds", async () => {
    const carried = 'Earlier in this conversation: the user asked which threads wait on them.';
    const text = await firstClaudeMessage('n-assistant-first', {
      toolProfile: restrictedChatProfile(), bootstrapInstructions: ASSISTANT_INSTRUCTIONS, mergeContexts: [carried],
    });
    assert.ok(text.startsWith(MICHI_ASSISTANT_MARKER), text.slice(0, 120));
    assert.ok(text.includes(carried) && text.endsWith('What is waiting?'));
    // A primary Agent's instructions still follow the context, as before.
    const plain = await firstClaudeMessage('n-agent-first', {
      bootstrapInstructions: 'You are the primary Agent for this conversation.', mergeContexts: [carried],
    });
    assert.ok(plain.indexOf(carried) < plain.indexOf('You are the primary Agent'), plain.slice(0, 120));
  });

  test("the assistant's system prompt offers no AskUserQuestion and none of the ordinary chat tools", async () => {
    await firstClaudeMessage('n-assistant-prompt', { toolProfile: restrictedChatProfile(), bootstrapInstructions: ASSISTANT_INSTRUCTIONS });
    const assistantPrompt = String(spawned[spawned.length - 1].systemPromptAppend);
    await firstClaudeMessage('n-plain-prompt', {});
    const plainPrompt = String(spawned[spawned.length - 1].systemPromptAppend);
    for (const pattern of [/save_artifact/, /spawn_branches/, /_scheduled_job/, /spawn_agent/, /Use AskUserQuestion or the Michi ask_user tool/]) {
      assert.doesNotMatch(assistantPrompt, pattern);
      assert.match(plainPrompt, pattern, 'ordinary chats keep their guidance');
    }
    assert.match(assistantPrompt, /Do NOT use the built-in AskUserQuestion tool/);
  });

  test('a YOLO chat bypasses permissions; the assistant in the same mode does not', async () => {
    const plain = await spawn('n-plain');
    const assistant = await spawn('n-assistant', restrictedChatProfile());
    await settle();
    try {
      assert.equal(spawned[0].permissionMode, 'bypassPermissions');
      assert.equal(spawned[0].disallowedTools, undefined);
      assert.equal(spawned[0].tools, undefined);
      assert.equal(spawned[0].restricted, false);
      assert.equal(spawned[0].isolateSettings, undefined);
      assert.equal(spawned[1].permissionMode, 'default');
      assert.deepEqual(spawned[1].tools, []);
      assert.deepEqual(spawned[1].disallowedTools, CLAUDE_ASSISTANT_DISALLOWED_TOOLS);
      assert.equal(spawned[1].strictMcpConfig, true);
      assert.equal(spawned[1].restricted, true, 'mandatory hooks, and no later switch to bypassPermissions');
      assert.equal(spawned[1].isolateSettings, true);
      assert.equal(spawned[1].restrictedMode, true);
      assert.equal(spawned[0].restrictedMode, undefined);
      assert.deepEqual(Object.keys(JSON.parse(spawned[1].mcpConfigInline).mcpServers), [MICHI_INTERNAL_MCP_NAME]);
      assert.equal(JSON.parse(spawned[1].mcpConfigInline).mcpServers[MICHI_INTERNAL_MCP_NAME].alwaysLoad, true,
        'its tools load up front: the assistant has no ToolSearch');
      assert.equal(plain.slot.exposedToolNames, undefined);
      assert.equal(plain.slot.restricted, undefined);
      assert.equal(assistant.slot.restricted, true, 'the slot carries the profile mark its catalog needs');
      assert.deepEqual([...assistant.slot.exposedToolNames].sort(), [...ASSISTANT_ALLOWED_TOOL_NAMES].sort());

      const allow = await assistant.onApprove({ toolName: 'mcp____michi_internal____list_workspaces', input: {}, toolUseId: 't1' });
      assert.equal(allow.behavior, 'allow');
      const denied = ['Bash', 'Write', 'Edit', 'Read', 'ToolSearch', 'Task', 'Skill', 'list_workspaces',
        `${MICHI_MCP_TOOL_PREFIX}save_artifact`, `${MICHI_MCP_TOOL_PREFIX}spawn_branches`, `${MICHI_MCP_TOOL_PREFIX}send_to_thread`,
        ...LEGACY_DESK_TOOLS.map((name) => `${MICHI_MCP_TOOL_PREFIX}${name}`),
        ...SCHEDULED_JOB_TOOL_NAMES.map((name) => `${MICHI_MCP_TOOL_PREFIX}${name}`),
        'mcp__slack__post_message', 'mcp__other__list_workspaces'];
      for (const toolName of denied) {
        const verdict = await assistant.onApprove({ toolName, input: {}, toolUseId: toolName });
        assert.equal(verdict.behavior, 'deny', toolName);
      }

      // The SDK's own gates: the mandatory PreToolUse hook and canUseTool.
      const signal = new AbortController().signal;
      const sdk = spawned[1] as { preToolUse: Function; authorize: Function };
      for (const name of ['list_workspaces', 'read_conversation_updates', 'read_page', 'ask_user']) {
        const toolName = `${MICHI_MCP_TOOL_PREFIX}${name}`;
        assert.equal((await sdk.preToolUse(toolName, { a: 1 }, 'h', signal))?.behavior, 'allow', toolName);
        assert.deepEqual(await sdk.authorize(toolName, { a: 1 }, 'c', signal), { behavior: 'allow', updatedInput: { a: 1 } }, toolName);
      }
      for (const toolName of denied) {
        assert.equal((await sdk.preToolUse(toolName, {}, 'h', signal))?.behavior, 'deny', toolName);
        assert.equal((await sdk.authorize(toolName, {}, 'c', signal)).behavior, 'deny', toolName);
      }
      const cancelled = new AbortController();
      cancelled.abort();
      assert.equal((await sdk.preToolUse(`${MICHI_MCP_TOOL_PREFIX}list_workspaces`, {}, 'h', cancelled.signal))?.behavior, 'deny',
        'a cancelled turn runs nothing');
      // An ordinary chat's hook leaves its tools to its own permission mode.
      assert.equal(await (spawned[0] as { preToolUse: Function }).preToolUse('Bash', {}, 'h', signal), undefined);
    } finally {
      await plain.session.dispose();
      await assistant.session.dispose();
    }
  });

  test('the assistant keeps running when Claude reports only its Michi tools', async () => {
    const { session } = await spawn('n-assistant', restrictedChatProfile());
    try {
      await settle();
      assert.notEqual((session as any).state, 'crashed');
      assert.equal(children[0].killed, false);
    } finally {
      await session.dispose();
    }
  });

  test('the assistant is stopped when Claude reports a tool, MCP server or permission mode it may not have, or no list', async () => {
    const cases: Array<NonNullable<typeof misbehave>> = [
      { tools: ['Bash', ...initToolsFor({ tools: [] })] },
      { tools: [`${MICHI_MCP_TOOL_PREFIX}save_artifact`] },
      { tools: null },
      { servers: [MICHI_INTERNAL_MCP_NAME, 'slack'] },
      { servers: null },
      { permissionMode: 'bypassPermissions' },
      { permissionMode: 'acceptEdits' },
    ];
    for (const [i, fault] of cases.entries()) {
      children.length = 0;
      misbehave = fault;
      const { session } = await spawn(`n-assistant-${i}`, restrictedChatProfile());
      try {
        await settle();
        assert.equal((session as any).state, 'crashed', JSON.stringify(fault));
        assert.equal(children[0].killed, true, 'the process is stopped');
      } finally {
        await session.dispose();
      }
    }
  });

  const michiTool = (name: string) => `${MICHI_MCP_TOOL_PREFIX}${name}`;
  const verdicts = async (args: { preToolUse: Function; authorize: Function }, name = 'list_workspaces') => {
    const signal = new AbortController().signal;
    return [(await args.preToolUse(michiTool(name), {}, 'h', signal))?.behavior, (await args.authorize(michiTool(name), {}, 'c', signal)).behavior];
  };

  test('no assistant tool runs before its init has been checked', async () => {
    misbehave = { withholdInit: true };
    const { session, slot } = await spawn('n-assistant', restrictedChatProfile());
    try {
      await settle();
      assert.deepEqual(await verdicts(spawned[0]), ['deny', 'deny'], 'the hook and canUseTool refuse its own tools too');
      const signal = new AbortController().signal;
      assert.match((await spawned[0].preToolUse(michiTool('edit_page'), {}, 'h', signal)).message, /not reported a safe setup/);
      assert.equal(slot.isServing(), false, 'and its MCP slot serves nothing');
      goodInit(children[0], spawned[0]);
      await settle();
      assert.deepEqual(await verdicts(spawned[0]), ['allow', 'allow']);
      assert.equal(slot.isServing(), true);
    } finally {
      await session.dispose();
    }
  });

  test("the real 2.1.305 envelopes, command_lifecycle first, keep the assistant running and verified", async () => {
    misbehave = { withholdInit: true };
    const { session, slot } = await spawn('n-assistant', restrictedChatProfile());
    try {
      for (const envelope of [...REAL_ASSISTANT_INIT.preInit, REAL_ASSISTANT_INIT.init]) {
        children[0].stdout.push(JSON.stringify(envelope) + '\n');
      }
      await settle();
      assert.notEqual((session as any).state, 'crashed');
      assert.equal(children[0].killed, false, 'no false positive');
      assert.equal((session as any).assistantInitVerified, true);
      assert.equal(slot.isServing(), true);
      assert.deepEqual(await verdicts(spawned[0], 'list_workspaces'), ['allow', 'allow']);
    } finally {
      await session.dispose();
    }
  });

  test('a failed init stops the assistant\'s tools at once, while its process is still exiting', async () => {
    misbehave = { tools: ['Bash', ...initToolsFor({ tools: [] })], slowExit: true };
    const { session, slot } = await spawn('n-assistant', restrictedChatProfile());
    try {
      await settle();
      assert.equal((session as any).state, 'crashed');
      assert.equal(children[0].killed, true, 'asked to stop…');
      assert.ok((session as any).child, '…but not exited yet: its slot is still registered');
      assert.equal(slot.isServing(), false);
      assert.deepEqual(await verdicts(spawned[0]), ['deny', 'deny']);
      assert.deepEqual(await verdicts(spawned[0], 'edit_page'), ['deny', 'deny']);
    } finally {
      await session.dispose();
    }
  });

  test('the next send after a failed init says why the session stopped', async () => {
    misbehave = { tools: ['Bash', ...initToolsFor({ tools: [] })] };
    const { session } = await spawn('n-assistant', restrictedChatProfile());
    try {
      await settle();
      assert.equal((session as any).state, 'crashed');
      const turn = session.send('Anything waiting?')[Symbol.asyncIterator]();
      await assert.rejects(async () => { for (;;) { const step = await turn.next(); if (step.done) break; } },
        (error: unknown) => error instanceof MetaAgentGuardError
          && error.violation.runtimeId === 'claude' && error.violation.toolset === 'chat'
          && error.violation.unexpectedTools.join() === 'native:Bash');
    } finally {
      await session.dispose();
    }
  });

  test('the turn whose init fails the check ends with MetaAgentGuardError', async () => {
    misbehave = { withholdInit: true };
    const { session } = await spawn('n-assistant', restrictedChatProfile());
    try {
      const turn = (async () => { for await (const _event of session.send('Anything waiting?')) { /* drain */ } })();
      await settle();
      children[0].emitInit('ext-bad', [...initToolsFor({ tools: [] }), `${MICHI_MCP_TOOL_PREFIX}send_to_thread`], {
        mcp_servers: [{ name: MICHI_INTERNAL_MCP_NAME, status: 'connected' }], permissionMode: 'default',
      });
      await assert.rejects(turn, (error: unknown) => error instanceof MetaAgentGuardError && error.violation.unexpectedTools.join() === 'send_to_thread');
      assert.equal((session as any).state, 'crashed');
    } finally {
      await session.dispose();
    }
  });

  test('a maintenance session is held to the maintenance toolset', async () => {
    const maintenanceInit = META_AGENT_MAINTENANCE_TOOL_NAMES.map((name) => `${MICHI_MCP_TOOL_PREFIX}${name}`);
    misbehave = { tools: maintenanceInit };
    const good = await spawn('n-maintenance-ok', maintenanceToolProfile());
    await settle();
    try {
      assert.notEqual((good.session as any).state, 'crashed');
      assert.equal(spawned[0].permissionMode, 'default');
      assert.deepEqual(spawned[0].tools, []);
      assert.equal(spawned[0].strictMcpConfig, true);
      assert.equal(spawned[0].restrictedMode, true);
    } finally {
      await good.session.dispose();
    }
    for (const extra of [`${MICHI_MCP_TOOL_PREFIX}list_workspaces`, 'Bash']) {
      children.length = 0;
      misbehave = { tools: [...maintenanceInit, extra] };
      const { session } = await spawn(`n-maintenance-${extra}`, maintenanceToolProfile());
      try {
        await settle();
        assert.equal((session as any).state, 'crashed', extra);
        assert.equal(children[0].killed, true);
        const error = (session as any).lastGuardError;
        assert.ok(error instanceof MetaAgentGuardError, extra);
        assert.equal(error.violation.toolset, 'maintenance');
      } finally {
        await session.dispose();
      }
    }
  });

  test('an assistant that answers before its init is stopped; an ordinary chat is not', async () => {
    misbehave = { outputBeforeInit: true };
    const assistant = await spawn('n-assistant', restrictedChatProfile());
    const plain = await spawn('n-plain');
    try {
      await settle();
      assert.equal((assistant.session as any).state, 'crashed');
      assert.equal(children[0].killed, true);
      assert.equal(assistant.slot.isServing(), false);
      assert.notEqual((plain.session as any).state, 'crashed');
      assert.equal(children[1].killed, false);
      assert.equal(plain.slot.isServing, undefined, 'an ordinary slot has no serving gate');
      const signal = new AbortController().signal;
      assert.equal(await spawned[1].preToolUse('Bash', {}, 'h', signal), undefined, 'nor a changed hook');
    } finally {
      await assistant.session.dispose();
      await plain.session.dispose();
    }
  });

  test('an ordinary chat is not held to the assistant\'s tool list', async () => {
    misbehave = { tools: ['Bash', 'Edit'], servers: [MICHI_INTERNAL_MCP_NAME, 'slack'] };
    const { session } = await spawn('n-plain');
    try {
      await settle();
      assert.notEqual((session as any).state, 'crashed');
    } finally {
      await session.dispose();
    }
  });

  test('a Claude Code without --tools stops the assistant with an error that says so', async () => {
    misbehave = { stderr: "error: unknown option '--tools='\n" };
    const { session } = await spawn('n-assistant', restrictedChatProfile());
    // stderr arrives after spawnFresh returns; record what the process pushes.
    const events: any[] = [];
    const queue = (session as any).queue;
    const push = queue.push.bind(queue);
    queue.push = (event: any) => { events.push(event); return push(event); };
    try {
      await settle();
      assert.equal((session as any).state, 'crashed');
      const error = events.find((event) => event.kind === 'runtime_error');
      assert.match(error?.error ?? '', /no --tools option/);
    } finally {
      await session.dispose();
    }
  });

  test('a Claude Code without --restricted stops the assistant with an error that says so', async () => {
    misbehave = { stderr: "error: unknown option '--restricted'\n" };
    const { session } = await spawn('n-assistant', restrictedChatProfile());
    const events: any[] = [];
    const queue = (session as any).queue;
    const push = queue.push.bind(queue);
    queue.push = (event: any) => { events.push(event); return push(event); };
    try {
      await settle();
      assert.equal((session as any).state, 'crashed');
      assert.match(events.find((event) => event.kind === 'runtime_error')?.error ?? '', /no --restricted option/);
    } finally {
      await session.dispose();
    }
  });

  test('an Agent Run\'s permission broker classifies Michi tools by their bare names', async () => {
    const { ClaudeSession } = require('michi-runtime/internal/adapters/claude/ClaudeSession') as typeof import('michi-runtime/internal/adapters/claude/ClaudeSession');
    const asked: string[] = [];
    const session = new ClaudeSession('att-1', {
      options: claudeTestOptions(),
      nodeId: 'n-run', cwd: tmpDir, workspaceId: null, bridge,
      mcpRegistry: { create: () => ({ slotId: 'slot-run' }), dispose: async () => {}, endpoint: (slotId: string) => ({ type: 'http' as const, url: `http://127.0.0.1:3000/api/mcp/${slotId}`, headers: [] }), },
      owner: runOwner('r-1', 'att-1'),
      toolProfile: { allowedToolNames: ['list_threads'] },
      permissionBroker: { requestPermission: async ({ toolName }: { toolName: string }) => { asked.push(toolName); return 'allow_once'; } },
    } as any);
    const onApprove = (session as any).makeOnApprove() as (p: { toolName: string; input: unknown; toolUseId: string }) => Promise<any>;
    assert.equal((await onApprove({ toolName: 'mcp____michi_internal____list_threads', input: {}, toolUseId: 't1' })).behavior, 'allow');
    assert.deepEqual(asked, ['list_threads'], 'so the Run policy sees a read, not an unknown external action');
    assert.equal((await onApprove({ toolName: 'mcp____michi_internal____save_artifact', input: {}, toolUseId: 't2' })).behavior, 'deny');
    assert.equal((await onApprove({ toolName: 'Bash', input: {}, toolUseId: 't3' })).behavior, 'deny');
    assert.deepEqual(asked, ['list_threads'], 'tools outside the allow-list never reach the broker');
    await session.dispose();
  });
});

// ── Codex session ───────────────────────────────────────────────────────────

interface CodexStubOptions {
  /** MCP servers in the user's effective Codex config (config/read). */
  configured?: string[];
  /**
   * What mcpServerStatus/list reports for the thread: a list, or the whole
   * answer for the Nth call (from 0); default: Michi's server connected and
   * every configured server disabled.
   */
  statuses?: Array<{ name: string; runtimeStatus: string }> | ((call: number) => unknown);
}

function stubCodexClient(threadId: string, stub: CodexStubOptions = {}) {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let serverRequest: ((method: string, params: Record<string, unknown>, respond: (r: unknown) => void, ctx?: unknown) => void) | null = null;
  const handlers = new Map<string, Set<(method: string, params: Record<string, unknown>) => void>>();
  const titleThread = `${threadId}-title`;
  let statusCalls = 0;
  let turnCount = 0;
  const client: any = {
    requests,
    ensureStarted: async () => {},
    request: async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === 'thread/start' || method === 'thread/resume') return { threadId: params.ephemeral ? titleThread : threadId };
      if (method === 'model/list') return { data: [] };
      if (method === 'config/read') {
        return { config: { mcp_servers: Object.fromEntries((stub.configured ?? []).map((name) => [name, { command: name }])) }, origins: {} };
      }
      if (method === 'mcpServerStatus/list') {
        const call = statusCalls++;
        if (typeof stub.statuses === 'function') return stub.statuses(call);
        return { data: stub.statuses ?? [
          { name: '__michi_internal__', runtimeStatus: 'connected' },
          ...(stub.configured ?? []).map((name) => ({ name, runtimeStatus: 'disabled' })),
        ] };
      }
      if (method === 'turn/start') {
        if (params.threadId === titleThread) {
          queueMicrotask(() => client.emit(titleThread, 'turn/completed', { threadId: titleThread, turn: { id: 'title-turn', status: 'completed' } }));
          return { turn: { id: 'title-turn' } };
        }
        return { turn: { id: `turn-${++turnCount}` } };
      }
      return {};
    },
    onNotification: (id: string, handler: (method: string, params: Record<string, unknown>) => void) => {
      let set = handlers.get(id);
      if (!set) { set = new Set(); handlers.set(id, set); }
      set.add(handler);
      return () => { set!.delete(handler); };
    },
    onGlobalNotification: () => () => {},
    onServerRequest: (handler: typeof serverRequest) => { serverRequest = handler; },
    onExit: () => () => {},
    shutdown: async () => {},
    isRunning: () => true,
    emit(id: string, method: string, params: Record<string, unknown>) {
      for (const handler of handlers.get(id) ?? []) handler(method, params);
    },
    fire(method: string, params: Record<string, unknown>): Promise<unknown> {
      return new Promise((resolve) => serverRequest!(method, params, resolve, { signal: undefined, reject: () => resolve({ rejected: true }) }));
    },
  };
  return client;
}

describe('Codex assistant session', () => {
  afterEach(() => __resetRuntimeDeps());

  async function start(t: TestContext, threadId: string, toolProfile?: ReturnType<typeof assistantToolProfile>, stub: CodexStubOptions = {}) {
    configureYolo();
    const client = stubCodexClient(threadId, stub);
    const slots: any[] = [];
    const registry = { create: (_p: string, _c: string, _o: unknown, cbs: unknown) => { slots.push(cbs); return { slotId: `slot-${threadId}` }; }, dispose: async () => {}, get: () => undefined };
    const runtime = new CodexRuntime({ ...codexTestOptions(), bridge, mcpSlots: fakeMcpRegistry(registry as unknown as Partial<McpSlotProvider>, { mcpPort: 3001 }) }, { client });
    const session = await runtime.newSession({ sessionId: `n-${threadId}`, cwd: '/tmp/test', model: 'test-model', ...(toolProfile ? { toolProfile } : {}) }) as CodexSession;
    const turn = (async () => { for await (const _event of session.send('hello')) { /* drain */ } })();
    t.after(async () => {
      client.emit(threadId, 'turn/completed', { threadId, turn: { id: 'turn-1', status: 'completed' } });
      await runtime.shutdown();
      await turn;
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { client, session, slot: slots[0] };
  }

  test('interactive Assistant leaves native and user MCP tools enabled in Codex', async (t) => {
    const { session } = await start(t, 'thread-unrestricted', assistantToolProfile(), { configured: ['user-server'] });
    assert.equal(session.isAssistant, false, 'this legacy runtime flag means restricted, not Assistant identity');
    assert.deepEqual(session.metaAgentToolProfile, assistantToolProfile(), 'resume retains Assistant identity without restricting tools');
    assert.equal(session.enableFollowUps, false);
  });

  test("an assistant conversation's first message opens with the marker, ahead of any context Michi adds", async (t) => {
    configureYolo();
    const client = stubCodexClient('thread-first');
    const registry = { create: () => ({ slotId: 'slot-first' }), dispose: async () => {}, get: () => undefined };
    const runtime = new CodexRuntime({ ...codexTestOptions(), bridge, mcpSlots: fakeMcpRegistry(registry as unknown as Partial<McpSlotProvider>, { mcpPort: 3001 }) }, { client });
    const carried = 'Earlier in this conversation: the user asked which threads wait on them.';
    const session = await runtime.newSession({
      sessionId: 'n-first', cwd: '/tmp/test', model: 'test-model',
      toolProfile: restrictedChatProfile(), bootstrapInstructions: ASSISTANT_INSTRUCTIONS, mergeContexts: [carried],
    }) as CodexSession;
    const turn = (async () => { for await (const _event of session.send('What is waiting?')) { /* drain */ } })();
    t.after(async () => {
      client.emit('thread-first', 'turn/completed', { threadId: 'thread-first', turn: { id: 'turn-1', status: 'completed' } });
      await runtime.shutdown();
      await turn;
    });
    for (let i = 0; i < 100 && !client.requests.some((r: any) => r.method === 'turn/start'); i += 1) await new Promise((r) => setTimeout(r, 5));
    const turnStart = client.requests.find((r: any) => r.method === 'turn/start' && r.params.threadId === 'thread-first');
    const text = (turnStart.params.input as Array<{ type: string; text?: string }>).find((part) => part.type === 'text')!.text!;
    // Michi titles a Codex conversation by this message's first line.
    assert.ok(text.startsWith(MICHI_ASSISTANT_MARKER), text.slice(0, 120));
    assert.ok(text.includes(carried) && text.includes('What is waiting?'));
  });

  test('the assistant runs read-only in YOLO mode and declines every approval', async (t) => {
    const { client, session, slot } = await start(t, 'thread-assistant', restrictedChatProfile(), { configured: ['asana-mcp', 'node_repl'] });
    assert.deepEqual([...slot.exposedToolNames].sort(), [...ASSISTANT_ALLOWED_TOOL_NAMES].sort());
    assert.equal(slot.restricted, true);
    const threadStart = client.requests.find((r: any) => r.method === 'thread/start' && !r.params.ephemeral);
    assert.equal(threadStart.params.sandbox, 'read-only');
    // The user's MCP servers are disabled, Codex's shell and plugins off, and Michi checks the result.
    const config = threadStart.params.config;
    assert.deepEqual(config.mcp_servers['asana-mcp'], { enabled: false });
    assert.deepEqual(config.mcp_servers.node_repl, { enabled: false });
    assert.match(config.mcp_servers.__michi_internal__.url, /\/api\/mcp\//);
    assert.equal(config.features.shell_tool, false);
    assert.equal(config.features.plugins, false);
    assert.equal(config.web_search, 'disabled');
    const methods = client.requests.map((r: any) => r.method);
    assert.ok(methods.indexOf('config/read') < methods.indexOf('thread/start'));
    const check = client.requests.find((r: any) => r.method === 'mcpServerStatus/list');
    assert.equal(check?.params.threadId, 'thread-assistant');
    const turnStart = client.requests.find((r: any) => r.method === 'turn/start' && r.params.threadId === 'thread-assistant');
    assert.equal(turnStart.params.approvalPolicy, 'on-request');
    assert.deepEqual(turnStart.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    assert.ok(session.isAssistant);

    const command = await client.fire(CODEX_SERVER_REQUESTS.commandApproval, { threadId: 'thread-assistant', turnId: 'turn-1', command: 'rm -rf /' });
    assert.deepEqual(command, { decision: 'decline' });
    const file = await client.fire(CODEX_SERVER_REQUESTS.fileChangeApproval, { threadId: 'thread-assistant', turnId: 'turn-1' });
    assert.deepEqual(file, { decision: 'decline' });
    const elicitation = await client.fire(CODEX_SERVER_REQUESTS.mcpElicitation, {
      threadId: 'thread-assistant', turnId: 'turn-1', serverName: 'user-mcp', mode: 'form', message: 'Post?', requestedSchema: { type: 'object', properties: {} }, _meta: null,
    });
    assert.deepEqual(elicitation, { action: 'decline', content: null, _meta: null });
    assert.ok(!client.requests.some((r: any) => r.method === 'thread/start' && r.params.ephemeral),
      'no title thread: it would run outside the assistant\'s lockdown');
    // Nor does its developer prompt advertise the ordinary chat tools.
    for (const pattern of [/save_artifact/, /spawn_branches/, /_scheduled_job/, /spawn_agent/, /`bash`/]) {
      assert.doesNotMatch(String(threadStart.params.developerInstructions), pattern);
    }
    assert.match(String(threadStart.params.developerInstructions), /Michi assistant's own/);
    const text = (turnStart.params.input as Array<{ type: string; text?: string }>).find((part) => part.type === 'text')!.text!;
    for (const prompt of [String(threadStart.params.developerInstructions), text]) {
      assert.doesNotMatch(prompt, /\[TITLE:|\[FOLLOW-UP|\[BRANCH-OVERVIEW:|set_branch_overview|set_follow_ups/);
    }
    assert.equal(session.enableFollowUps, false);
    assert.equal(slot.onSetBranchOverview, undefined);
    assert.equal(slot.onValidateFollowUps, undefined);
  });

  test('assistant native resume and repeated turns stay free of metadata even with the hook experiment enabled', async (t) => {
    configureYolo();
    const threadId = 'thread-meta-resume';
    const repository = require('../src/services/dbRepository') as typeof import('../src/services/dbRepository');
    t.mock.method(repository, 'getNode', () => ({ id: 'n-meta-resume', external_session_id: threadId, runtime_id: 'codex' }) as any);
    const client = stubCodexClient(threadId);
    const slots: any[] = [];
    const registry = { create: (_p: string, _c: string, _o: unknown, cbs: unknown) => { slots.push(cbs); return { slotId: 'slot-meta-resume' }; }, dispose: async () => {}, get: () => undefined };
    const runtime = new CodexRuntime({ ...codexTestOptions(), bridge: bridge, mcpSlots: fakeMcpRegistry(registry as any, { mcpPort: 3001 }) }, { client, followUpsHookPocEnabled: true, followUpsExperimentMode: 'hook-tool' });
    t.after(() => runtime.shutdown());
    const session = await runtime.loadSession({ sessionId: 'n-meta-resume', cwd: '/tmp/test', model: 'test-model', toolProfile: restrictedChatProfile(), enableFollowUps: true }) as CodexSession;
    const resume = client.requests.find((r: any) => r.method === 'thread/resume');
    assert.equal(resume.params.config.hooks, undefined);
    assert.match(resume.params.developerInstructions, /^You are Michi,/);
    assert.doesNotMatch(resume.params.developerInstructions, /\[TITLE:|\[FOLLOW-UP|\[BRANCH-OVERVIEW:|set_branch_overview|set_follow_ups/);
    for (const [index, message] of ['Summarize this page.', 'What changed?'].entries()) {
      const turn = (async () => { for await (const _event of session.send(message)) { /* drain */ } })();
      await new Promise((resolve) => setImmediate(resolve));
      const request = client.requests.filter((r: any) => r.method === 'turn/start').at(-1);
      assert.deepEqual(request.params.input, [{ type: 'text', text: message }]);
      client.emit(threadId, 'turn/completed', { threadId, turn: { id: `turn-${index + 1}`, status: 'completed' } });
      await turn;
    }
    assert.equal(slots[0].onSetBranchOverview, undefined);
    assert.equal(slots[0].onValidateFollowUps, undefined);
  });

  test('a server config/read did not name is turned off on a second start, and that thread is used', async (t) => {
    const { client } = await start(t, 'thread-retry', restrictedChatProfile(), {
      configured: ['asana-mcp'],
      statuses: (call) => ({ data: [
        { name: '__michi_internal__', runtimeStatus: 'connected' },
        { name: 'asana-mcp', runtimeStatus: 'disabled' },
        { name: 'profile-mcp', runtimeStatus: call === 0 ? 'starting' : 'disabled' },
      ] }),
    });
    const starts = client.requests.filter((r: any) => r.method === 'thread/start' && !r.params.ephemeral);
    assert.equal(starts.length, 2);
    assert.equal(starts[0].params.config.mcp_servers['profile-mcp'], undefined);
    assert.deepEqual(starts[1].params.config.mcp_servers['profile-mcp'], { enabled: false });
    assert.deepEqual(starts[1].params.config.mcp_servers['asana-mcp'], { enabled: false });
    const methods = client.requests.map((r: any) => r.method);
    assert.ok(methods.indexOf('thread/unsubscribe') < methods.lastIndexOf('thread/start'), 'the first thread is let go first');
    assert.ok(client.requests.some((r: any) => r.method === 'turn/start' && r.params.threadId === 'thread-retry'));
  });

  for (const [name, statuses, reason] of [
    ['an answer without a server list', () => ({ servers: [] }), /did not list the thread's MCP servers/],
    ['a list without Michi\'s own server', () => ({ data: [] }), /Michi's own MCP server is missing/],
  ] as const) {
    test(`${name} refuses the assistant thread without a second try`, async () => {
      configureYolo();
      const client = stubCodexClient('thread-fatal', { statuses });
      const registry = { create: () => ({ slotId: 'slot-fatal' }), dispose: async () => {}, get: () => undefined };
      const runtime = new CodexRuntime({ ...codexTestOptions(), bridge, mcpSlots: fakeMcpRegistry(registry as unknown as Partial<McpSlotProvider>, { mcpPort: 3001 }) }, { client });
      try {
        await assert.rejects(
          runtime.newSession({ sessionId: 'n-fatal', cwd: '/tmp/test', model: 'test-model', toolProfile: restrictedChatProfile() }),
          reason,
        );
        assert.equal(client.requests.filter((r: any) => r.method === 'thread/start').length, 1);
      } finally {
        await runtime.shutdown();
      }
    });
  }

  test('an assistant thread that still has a user MCP server enabled is refused', async () => {
    configureYolo();
    const client = stubCodexClient('thread-open', {
      configured: ['asana-mcp'],
      statuses: [{ name: '__michi_internal__', runtimeStatus: 'connected' }, { name: 'late-mcp', runtimeStatus: 'starting' }],
    });
    const registry = { create: () => ({ slotId: 'slot-open' }), dispose: async () => {}, get: () => undefined };
    const runtime = new CodexRuntime({ ...codexTestOptions(), bridge, mcpSlots: fakeMcpRegistry(registry as unknown as Partial<McpSlotProvider>, { mcpPort: 3001 }) }, { client });
    try {
      await assert.rejects(
        runtime.newSession({ sessionId: 'n-open', cwd: '/tmp/test', model: 'test-model', toolProfile: restrictedChatProfile() }),
        /late-mcp/,
      );
      assert.ok(client.requests.some((r: any) => r.method === 'thread/unsubscribe' && r.params.threadId === 'thread-open'),
        'the refused thread is let go');
    } finally {
      await runtime.shutdown();
    }
  });

  test('an ordinary YOLO chat keeps full access (unchanged)', async (t) => {
    const { client, session, slot } = await start(t, 'thread-plain', undefined, { configured: ['asana-mcp'] });
    assert.equal(slot.exposedToolNames, undefined);
    assert.equal(slot.restricted, undefined);
    const threadStart = client.requests.find((r: any) => r.method === 'thread/start' && !r.params.ephemeral);
    assert.equal(threadStart.params.sandbox, 'workspace-write');
    // An ordinary thread turns off only Codex goals, whose self-started turns Michi does not show.
    assert.deepEqual(threadStart.params.config.features, { goals: false });
    // The user's MCP servers are disabled by name (spec §2), checked afterwards without refusing the chat.
    assert.deepEqual(threadStart.params.config.mcp_servers['asana-mcp'], { enabled: false });
    assert.ok(threadStart.params.config.mcp_servers[CODEX_MICHI_MCP_SERVER], 'Michi\'s own server stays');
    assert.ok(client.requests.some((r: any) => r.method === 'config/read'));
    assert.ok(client.requests.some((r: any) => r.method === 'mcpServerStatus/list'));
    const turnStart = client.requests.find((r: any) => r.method === 'turn/start' && r.params.threadId === 'thread-plain');
    assert.equal(turnStart.params.sandboxPolicy.type, 'dangerFullAccess');
    assert.equal(session.isAssistant, false);
    const titleStart = client.requests.find((r: any) => r.method === 'thread/start' && r.params.ephemeral);
    assert.ok(titleStart, 'an ordinary chat still gets its title thread');
    assert.deepEqual(titleStart.params.config.mcp_servers, { 'asana-mcp': { enabled: false } });
    assert.match(String(threadStart.params.developerInstructions), /save_artifact/, 'and its tool guidance');
  });
});

describe('Codex Meta agent', () => {
  afterEach(() => __resetRuntimeDeps());

  const source = { sourceTurnId: 'turn-s', evidence: { nodeId: 'n-s', turnId: 'turn-s', assistantId: 'a-s' }, manifest: [] };
  const maintenanceInput = (workspaceId: string) => ({
    turnId: 'turn-m', assistantMessageId: 'a-m',
    maintenanceContext: {
      workspaceId, ownerUserId: 'local-user', jobId: 'job-1', runId: 'run-1', claimedBy: 'w', configRevision: 1, planId: 'plan-1', sources: [source],
    },
  });

  test('the MCP status becomes a catalog: Michi tools by bare name, other open servers by name', () => {
    assert.deepEqual(codexMetaAgentCatalog([
      { name: CODEX_MICHI_MCP_SERVER, runtimeStatus: 'connected', tools: { list_threads: { name: 'list_threads' }, mcp____michi_internal____read_node: {} } },
      { name: 'asana-mcp', runtimeStatus: 'disabled', tools: { post: { name: 'post' } } },
      { name: 'late', runtimeStatus: 'starting' },
    ]), ['list_threads', 'read_node', 'mcp_server:late']);
    assert.deepEqual(codexMetaAgentCatalog([{ name: CODEX_MICHI_MCP_SERVER, tools: [{ name: 'read_page' }, 'ask_user'] }]), ['read_page', 'ask_user']);
    assert.deepEqual([...CODEX_META_AGENT_UNREMOVABLE_TOOLS], ['image_generation', 'view_image', 'goals', 'request_user_input']);
  });

  test('background maintenance runs with the same lockdown, its own catalog and its source manifest', async (t) => {
    configureYolo();
    const client = stubCodexClient('thread-maint', { configured: ['asana-mcp'] });
    const slots: any[] = [];
    const registry = { create: (_p: string, _c: string, _o: unknown, cbs: unknown) => { slots.push(cbs); return { slotId: 'slot-maint' }; }, dispose: async () => {}, get: () => undefined };
    const runtime = new CodexRuntime({ ...codexTestOptions(), bridge: bridge, mcpSlots: fakeMcpRegistry(registry as any, { mcpPort: 3001 }) }, { client });
    const session = await runtime.newSession({
      sessionId: 'n-maint', cwd: '/tmp/test', model: 'test-model', workspaceId: 'ws-m', toolProfile: maintenanceToolProfile(),
    }) as CodexSession;
    let seenContext: unknown = 'unset';
    const turn = (async () => { for await (const _event of session.send('maintain', maintenanceInput('ws-m') as any)) { /* drain */ } })();
    t.after(async () => {
      client.emit('thread-maint', 'turn/completed', { threadId: 'thread-maint', turn: { id: 'turn-1', status: 'completed' } });
      await runtime.shutdown();
      await turn;
    });
    for (let i = 0; i < 100 && !client.requests.some((r: any) => r.method === 'turn/start'); i += 1) await new Promise((r) => setTimeout(r, 5));
    seenContext = slots[0].getActiveMaintenanceExecutionContext();

    const slot = slots[0];
    assert.equal(slot.maintenance, true);
    assert.equal(slot.assistant, undefined);
    assert.deepEqual([...slot.exposedToolNames].sort(), [...META_AGENT_MAINTENANCE_TOOL_NAMES].sort());
    assert.equal((seenContext as any)?.execution?.turnId, 'turn-m', 'the maintenance tools see the active send');
    const threadStart = client.requests.find((r: any) => r.method === 'thread/start' && !r.params.ephemeral);
    assert.equal(threadStart.params.sandbox, 'read-only');
    assert.deepEqual(threadStart.params.config.mcp_servers['asana-mcp'], { enabled: false });
    assert.equal(threadStart.params.config.features.shell_tool, false);
    assert.equal(threadStart.params.config.web_search, 'disabled');
    assert.equal(threadStart.params.config.hooks, undefined, 'no follow-up hooks for maintenance');
    assert.match(String(threadStart.params.developerInstructions), /Scheduled maintenance mode/);
    assert.ok(client.requests.some((r: any) => r.method === 'mcpServerStatus/list'));
    assert.ok(!client.requests.some((r: any) => r.method === 'thread/start' && r.params.ephemeral), 'no title thread');
    const turnStart = client.requests.find((r: any) => r.method === 'turn/start' && r.params.threadId === 'thread-maint');
    assert.deepEqual(turnStart.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    const text = (turnStart.params.input as Array<{ type: string; text?: string }>).find((part) => part.type === 'text')!.text!;
    assert.match(text, /Trusted maintenance source index/);
    assert.ok(session.isMetaAgent && session.isMaintenance && session.isAssistant);
    assert.deepEqual(await client.fire(CODEX_SERVER_REQUESTS.commandApproval, { threadId: 'thread-maint', turnId: 'turn-1', command: 'ls' }), { decision: 'decline' });
    const elicitation = await client.fire(CODEX_SERVER_REQUESTS.mcpElicitation, {
      threadId: 'thread-maint', turnId: 'turn-1', serverName: 'x', mode: 'form', message: '?', requestedSchema: { type: 'object', properties: {} }, _meta: null,
    });
    assert.deepEqual(elicitation, { action: 'decline', content: null, _meta: null });
  });

  test('a maintenance send without its trusted context is refused before any turn', async () => {
    configureYolo();
    const client = stubCodexClient('thread-noctx');
    const registry = { create: () => ({ slotId: 'slot-noctx' }), dispose: async () => {}, get: () => undefined };
    const runtime = new CodexRuntime({ ...codexTestOptions(), bridge: bridge, mcpSlots: fakeMcpRegistry(registry as any, { mcpPort: 3001 }) }, { client });
    try {
      const session = await runtime.newSession({ sessionId: 'n-noctx', cwd: '/tmp/test', model: 'm', workspaceId: 'ws-m', toolProfile: maintenanceToolProfile() });
      await assert.rejects(async () => { for await (const _event of session.send('hi')) { /* drain */ } }, /missing a valid owner/);
      assert.ok(!client.requests.some((r: any) => r.method === 'turn/start'));
    } finally {
      await runtime.shutdown();
    }
  });

  for (const [label, profile, extra] of [
    ['chat', restrictedChatProfile(), 'send_to_thread'],
    ['maintenance', maintenanceToolProfile(), 'list_workspaces'],
  ] as const) {
    test(`a ${label} thread whose Michi server lists a tool outside its toolset fails with MetaAgentGuardError`, async () => {
      configureYolo();
      const client = stubCodexClient(`thread-extra-${label}`, {
        statuses: [{ name: CODEX_MICHI_MCP_SERVER, runtimeStatus: 'connected', tools: { [extra]: { name: extra } } } as any],
      });
      const registry = { create: () => ({ slotId: `slot-extra-${label}` }), dispose: async () => {}, get: () => undefined };
      const runtime = new CodexRuntime({ ...codexTestOptions(), bridge: bridge, mcpSlots: fakeMcpRegistry(registry as any, { mcpPort: 3001 }) }, { client });
      try {
        await assert.rejects(
          runtime.newSession({ sessionId: `n-extra-${label}`, cwd: '/tmp/test', model: 'm', workspaceId: 'ws-m', toolProfile: profile }),
          (error: unknown) => error instanceof MetaAgentGuardError && error.violation.runtimeId === 'codex'
            && error.violation.toolset === profile.metaAgentToolset && error.violation.unexpectedTools.join() === extra,
        );
      } finally {
        await runtime.shutdown();
      }
    });
  }

  test('a user MCP server Codex keeps enabled fails with MetaAgentGuardError naming it', async () => {
    configureYolo();
    const client = stubCodexClient('thread-open-guard', {
      statuses: [{ name: CODEX_MICHI_MCP_SERVER, runtimeStatus: 'connected' }, { name: 'late-mcp', runtimeStatus: 'starting' }],
    });
    const registry = { create: () => ({ slotId: 'slot-open-guard' }), dispose: async () => {}, get: () => undefined };
    const runtime = new CodexRuntime({ ...codexTestOptions(), bridge: bridge, mcpSlots: fakeMcpRegistry(registry as any, { mcpPort: 3001 }) }, { client });
    try {
      await assert.rejects(
        runtime.newSession({ sessionId: 'n-open-guard', cwd: '/tmp/test', model: 'm', workspaceId: 'ws-m', toolProfile: maintenanceToolProfile() }),
        (error: unknown) => error instanceof MetaAgentGuardError && error.violation.unexpectedTools.join() === 'mcp_server:late-mcp',
      );
    } finally {
      await runtime.shutdown();
    }
  });
});
