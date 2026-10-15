/** Real Kiro Runtime pilot. Run one variant per isolated process. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { AgentSession } from '../src/agents/types';

const variant = process.argv[2];
if (variant !== 'turn' && variant !== 'full') throw new Error('usage: script turn|full');
const runId = process.argv[3] ?? '2026-10-07-kiro-v3-pilot';
if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('run ID must contain only letters, numbers and hyphens');
const modelSetting = process.env.MICHI_NODE_SUMMARY_EXPERIMENT_MODEL ?? 'claude-sonnet-4.6';
const model = modelSetting === 'default' ? undefined : modelSetting;
const reasoningSetting = process.env.MICHI_NODE_SUMMARY_EXPERIMENT_REASONING ?? 'low';
if (reasoningSetting !== 'low' && reasoningSetting !== 'high' && reasoningSetting !== 'off') {
  throw new Error('reasoning must be low, high or off');
}
const reasoning = reasoningSetting === 'off' ? undefined : reasoningSetting as 'low' | 'high';
const engine = 'v3';
const fixtureSet = process.env.MICHI_NODE_SUMMARY_EXPERIMENT_FIXTURE ?? 'short';
if (fixtureSet !== 'short' && fixtureSet !== 'long') throw new Error('fixture must be short or long');
const outputDir = path.resolve(process.cwd(), 'benchmarks/node-summary/results', runId);
const outputFile = path.join(outputDir, `${variant}.json`);
if (fs.existsSync(outputFile)) throw new Error(`Refusing to overwrite ${outputFile}`);
fs.mkdirSync(outputDir, { recursive: true });
const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'michi-kiro-summary-')));
const previous = { ...process.env };
Object.assign(process.env, {
  MICHI_DATA_DIR: dataDir,
  MICHI_TITLE_MODEL_KIRO: 'off',
  MICHI_NODE_SUMMARY_EXPERIMENT_MODE: variant,
});
delete process.env.MICHI_CLOUD;

const shortFixtures = [
  { id: 'mobile-release', turns: [
    'Rabbit 手机应用 v1 原定 11 月 15 日发布，推送通知是当前第一优先级。请仅回复“已记录。”，并通过 set_branch_overview 记录摘要。',
    'Android 13 上通知注册失败，Lin 负责修复。请仅回复“已记录。”，并通过 set_branch_overview 记录摘要。',
    '现在改为 11 月 22 日发布；崩溃问题升为最高优先级，推送通知降级。Samsung 通知问题仍待修复。请仅回复“已记录。”，并通过 set_branch_overview 记录摘要。',
  ] },
  { id: 'search-design', turns: [
    '搜索后端初步选择 Elasticsearch；目标是 p95 小于 300 毫秒，支持中英文。请仅回复“已记录。”，并通过 set_branch_overview 记录摘要。',
    '用户只能搜索自己所属 workspace 的内容。请仅回复“已记录。”，并通过 set_branch_overview 记录摘要。',
    '因成本放弃 Elasticsearch，改用 PostgreSQL 全文搜索。实测 p95 是 420 毫秒，中文相关性仍待验证。请仅回复“已记录。”，并通过 set_branch_overview 记录摘要。',
  ] },
];

const longFixtures = [{ id: 'release-search-12-turns', turns: [
  'Northstar 手机应用 v1 计划 12 月 1 日发布；离线笔记是必须保留的功能，当前第一优先级是推送通知。',
  '所有笔记默认只存本地。同步可以作为可选功能，但上传前必须端到端加密；这不改变离线笔记必须可用的要求。',
  'Android 13 的通知注册失败，Lin 负责修复。这是 Android 系统注册问题。',
  '另有一个独立的 Samsung 设备通知问题，Mei 负责；它与 Android 13 注册失败不是同一个故障。',
  '发布日期推迟到 12 月 8 日，因为应用商店审核尚未完成。12 月 1 日的日期已作废。',
  '发现启动崩溃，Jia 负责；崩溃升为当前最高优先级，推送通知降级。离线笔记仍为发布必备。',
  '遥测只允许用户主动选择加入，且不得上传笔记正文；这条隐私约束在后续方案中仍须保留。',
  '搜索后端暂定 Elasticsearch；目标 p95 小于 300 毫秒，支持中英文。用户只能搜索自己所属 workspace 的内容。',
  '因成本放弃 Elasticsearch，改用 PostgreSQL 全文搜索；目前实测 p95 为 420 毫秒，中文相关性尚未验证。workspace 权限限制不变。',
  'Lin 已修复 Android 13 通知注册失败；Samsung 设备通知问题仍未解决，负责人仍是 Mei。',
  'PostgreSQL 搜索优化后实测 p95 为 275 毫秒，已达到小于 300 毫秒的目标；中文相关性仍待验证。',
  '发布现定为 12 月 15 日，12 月 8 日已作废。应用商店审核已通过；启动崩溃仍未解决，Jia 继续负责。其他未解决事项和既有约束不变。',
].map(text => `${text} 请仅回复“已记录。”，并通过 set_branch_overview 记录摘要。`) }];

const fixtures = fixtureSet === 'long' ? longFixtures : shortFixtures;

async function main() {
  const { closeDb, getDb, initDb } = require('../src/services/db') as typeof import('../src/services/db');
  const { configureRuntimeDeps, __resetRuntimeDeps } = require('../src/agents/runtimeDeps') as typeof import('../src/agents/runtimeDeps');
  const { clearAllSessions } = require('../src/agents/sessionRegistry') as typeof import('../src/agents/sessionRegistry');
  const config = require('../src/services/agentConfig') as typeof import('../src/services/agentConfig');
  const repo = require('../src/services/dbRepository') as typeof import('../src/services/dbRepository');
  const { McpSlotRegistry, mountMcp } = require('../src/services/mcpServer') as typeof import('../src/services/mcpServer');
  const { KiroRuntime } = require('../src/agents/kiro/KiroRuntime') as typeof import('../src/agents/kiro/KiroRuntime');
  closeDb(); initDb();
  configureRuntimeDeps({
    historyStore: { getNode: repo.getNode, listMessages: repo.listMessages,
      getWorkspace: repo.getWorkspace, getWorkspaceInstructions: repo.getWorkspaceInstructions,
      hasGrant: repo.hasGrant, grantPermission: repo.grantPermission },
    dataDir, providerKeys: { getProviderApiKey: () => null },
    agentConfig: { getAgentConfig: config.getAgentConfig, resolveModel: config.resolveModel,
      resolveReasoning: config.resolveReasoning },
  });
  const registry = new McpSlotRegistry();
  const app = express();
  app.use(express.json());
  const router = express.Router();
  mountMcp(router, registry);
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  let runtime: InstanceType<typeof KiroRuntime> | undefined;
  const records: unknown[] = [];
  const watchdog = setTimeout(() => { void runtime?.shutdown(); }, 300_000);
  try {
    const workspaceId = 'kiro-summary-pilot';
    getDb().prepare('INSERT INTO workspaces (id,name,cwd,created_at,updated_at) VALUES (?,?,?,1,1)')
      .run(workspaceId, 'Disposable Kiro summary pilot', dataDir);
    runtime = new KiroRuntime(
      { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
      registry, (server.address() as AddressInfo).port, dataDir, undefined, { engine },
    );
    for (const fixture of fixtures) {
      const nodeId = randomUUID();
      getDb().prepare("INSERT INTO nodes (id,workspace_id,kind,status,created_at) VALUES (?,?,'chat','idle',1)")
        .run(nodeId, workspaceId);
      const session: AgentSession = await runtime.newSession({
        cwd: dataDir, workspaceId, sessionId: nodeId, model, enableFollowUps: false,
        reasoning,
      });
      let seq = 0;
      for (let i = 0; i < fixture.turns.length; i++) {
        const text = fixture.turns[i];
        const userMessageId = randomUUID();
        const assistantMessageId = randomUUID();
        getDb().prepare("INSERT INTO messages (id,node_id,role,content,seq,created_at) VALUES (?,?, 'user', ?, ?, 1)")
          .run(userMessageId, nodeId, text, ++seq);
        const started = performance.now();
        let firstChunkMs: number | null = null;
        let lastChunkMs: number | null = null;
        let overviewMs: number | null = null;
        let answer = '';
        const overviews: string[] = [];
        const usage: Record<string, unknown>[] = [];
        const errors: string[] = [];
        const mcpWarnings: string[] = [];
        const tools: string[] = [];
        let stopReason: string | undefined;
        for await (const event of session.send(text, { userMessageId, assistantMessageId })) {
          const now = performance.now();
          if (event.kind === 'chunk') {
            if (firstChunkMs === null) firstChunkMs = Math.round(now - started);
            lastChunkMs = Math.round(now - started);
            answer += event.text;
          }
          if (event.kind === 'branch_overview') {
            overviewMs = Math.round(now - started);
            overviews.push(event.overview);
          }
          if (event.kind === 'usage_summary') usage.push({ ...event });
          if (event.kind === 'tool_call') tools.push(event.title);
          if (event.kind === 'runtime_error') errors.push(JSON.stringify(event));
          if (event.kind === 'mcp_server_error') mcpWarnings.push(JSON.stringify(event));
          if (event.kind === 'permission_request') {
            const allowOnce = event.options.find(option => option.kind === 'allow_once');
            if (/@michi\/set_branch_overview/.test(event.title) && allowOnce) {
              session.respondToPermission?.(event.requestId, allowOnce.optionId);
            } else {
              errors.push(`unexpected permission: ${event.title}`);
              session.cancelPermission?.(event.requestId);
            }
          }
          if (event.kind === 'user_input_request') session.skipUserInput?.(event.requestId);
          if (event.kind === 'turn_end') stopReason = event.stopReason;
        }
        const record = {
          fixtureId: fixture.id, variant, turn: i + 1,
          requestedModel: model ?? null, currentModelId: session.currentModelId,
          reasoning: reasoningSetting, engine, nodeId, nativeSessionId: session.nativeSessionId,
          firstChunkMs, lastChunkMs, overviewMs, totalMs: Math.round(performance.now() - started),
          answer, overviews, usage, tools, errors, mcpWarnings, stopReason: stopReason ?? null,
        };
        records.push(record);
        fs.writeFileSync(outputFile, JSON.stringify({
          runtime: 'Michi KiroRuntime + KiroSession + local MCP + isolated SQLite',
          kiroCliVersion: '2.28.0', variant, requestedModel: model ?? null,
          reasoning: reasoningSetting, fixtureSet, engine, fixtures, records,
        }, null, 2));
        process.stdout.write(`${variant} ${fixture.id} ${i + 1}: overview=${overviews.length} usage=${usage.length} errors=${errors.length} ${record.totalMs}ms\n`);
        if (errors.length || overviews.length !== 1) throw new Error(`Invalid Kiro turn: ${fixture.id}/${i + 1}`);
        getDb().prepare("INSERT INTO messages (id,node_id,role,content,seq,created_at) VALUES (?,?, 'assistant', ?, ?, 1)")
          .run(assistantMessageId, nodeId, answer, ++seq);
      }
    }
  } finally {
    clearTimeout(watchdog);
    await runtime?.shutdown();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    clearAllSessions(); __resetRuntimeDeps(); closeDb(); process.env = previous;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  assert.equal(records.length, fixtures.reduce((count, fixture) => count + fixture.turns.length, 0));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
