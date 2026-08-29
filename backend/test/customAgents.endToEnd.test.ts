import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  AgentDefinitionStatus,
  AgentPolicyCategory,
  AgentPolicyDecision,
  AgentRunCompletionMode,
  AgentRunEventType,
  AgentRunInvocationMode,
  AgentRunStatus,
  type AgentPermissionPolicyV1,
  type CreateAgentDefinitionRequestV1,
  type ResultBundleV1,
  type SpawnAgentRunRequestV1,
} from 'michi-shared';
import { createAgentRunAssembly, type AgentRunAssembly } from '../src/agents/agentRunAssembly';
import type {
  AgentRunExecutionEvent,
  AgentRunExecutionOutcome,
  AgentRunExecutor,
  AgentRunHandle,
  AgentRunSpec,
  ParentContinuationSink,
} from '../src/agents/runs/ports';
import { AgentCapabilityCatalog } from '../src/services/agentCapabilityCatalog';
import { AgentDefinitionService } from '../src/services/agentDefinitionService';
import { AgentDefinitionsRepository } from '../src/services/agentDefinitionsRepository';
import { closeDb, getDb, initDb } from '../src/services/db';

const OWNER = 'owner-a';
const OTHER_OWNER = 'owner-b';
const WORKSPACE = 'workspace-a';
const OTHER_WORKSPACE = 'workspace-b';

const buildPolicy: AgentPermissionPolicyV1 = {
  version: 1,
  preset: 'build',
  categories: {
    [AgentPolicyCategory.FilesystemWrite]: AgentPolicyDecision.Allow,
    [AgentPolicyCategory.ShellExec]: AgentPolicyDecision.Allow,
  },
  maxDelegationDepth: 3,
  maxConcurrentRuns: 4,
  maxWallTimeMs: 60_000,
  maxAttempts: 3,
  maxTokens: null,
  maxSpendMicros: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function completedBundle(spec: AgentRunSpec, conclusion: string, outputName: string): ResultBundleV1 {
  const cwd = spec.executionEnvironment.cwd;
  fs.writeFileSync(path.join(cwd, outputName), `${conclusion}\n`);
  const changedFiles = git(cwd, 'status', '--porcelain=v1').split('\n').filter(Boolean)
    .map((line) => line.slice(3)).sort();
  const snapshotHash = createHash('sha256')
    .update(changedFiles.map((name) => `${name}\0${fs.readFileSync(path.join(cwd, name))}`).join('\0'))
    .digest('hex');
  return {
    version: 1,
    status: 'completed',
    source: 'submitted',
    handoff: {
      conclusion,
      artifactsOrChanges: `${outputName} created in the isolated worktree`,
      unresolvedIssues: '',
    },
    artifacts: [],
    resourceMutations: [],
    externalActions: [],
    changeSet: {
      baseCommit: spec.executionEnvironment.baseCommit!,
      snapshotHash,
      worktreeId: path.basename(cwd),
      changedFiles,
      summary: `${changedFiles.length} file changed`,
      diffArtifactId: null,
    },
  };
}

class LifecycleExecutor implements AgentRunExecutor {
  readonly first = deferred<AgentRunExecutionOutcome>();
  readonly interrupted = deferred<AgentRunExecutionOutcome>();
  firstSpec: AgentRunSpec | null = null;
  interruptedSpec: AgentRunSpec | null = null;
  resumedSpec: AgentRunSpec | null = null;
  resumeToken: unknown = null;
  starts = 0;
  resumes = 0;

  async start(spec: AgentRunSpec, emit: (event: AgentRunExecutionEvent) => Promise<void>): Promise<AgentRunHandle> {
    this.starts += 1;
    assert.equal(spec.executionEnvironment.kind, 'git_worktree');
    assert.equal(fs.readFileSync(path.join(spec.executionEnvironment.cwd, 'base.txt'), 'utf8'), 'base\n');
    if (this.starts === 1) {
      this.firstSpec = spec;
      await emit({ type: AgentRunEventType.Assistant, payload: { version: 1, text: 'verbose worker transcript must stay private' } });
      return this.handle(this.first.promise);
    }
    this.interruptedSpec = spec;
    await emit({
      type: AgentRunEventType.Checkpoint,
      payload: { version: 1, checkpoint: 'durable-before-restart' },
      nativeResumeToken: { cursor: 'resume-cursor-1' },
    });
    return this.handle(this.interrupted.promise);
  }

  async resume(spec: AgentRunSpec, token: unknown): Promise<AgentRunHandle> {
    this.resumes += 1;
    this.resumedSpec = spec;
    this.resumeToken = token;
    const bundle = completedBundle(spec, 'Recovered and completed after restart', 'recovered-output.txt');
    return this.handle(Promise.resolve({ status: 'completed', resultBundle: bundle }));
  }

  private handle(completion: Promise<AgentRunExecutionOutcome>): AgentRunHandle {
    return {
      completion,
      input: async () => {},
      cancel: async () => {},
    };
  }
}

function definitionRequest(): CreateAgentDefinitionRequestV1 {
  return {
    version: 1,
    scope: 'workspace',
    workspaceId: WORKSPACE,
    name: 'Worktree Builder',
    description: 'Makes a bounded change in an isolated Git worktree.',
    instructions: 'Create the requested output and return a compact Result Bundle.',
    runtimeProfile: { version: 1, runtimeId: 'fixture-runtime', modelId: 'fixture-model' },
    fallbackChain: [],
    toolRefs: [],
    skillRefs: [],
    mcpServerRefs: [],
    permissionPolicy: buildPolicy,
    contextPolicy: {
      version: 1,
      includeWorkspaceInstructions: false,
      allowMessageContext: true,
      allowFileContext: true,
      allowArtifactContext: true,
      maxEstimatedChars: 10_000,
    },
    defaultRunTtlMs: null,
  };
}

function spawnRequest(agentId: string, task: string): SpawnAgentRunRequestV1 {
  return {
    version: 1,
    workspaceId: WORKSPACE,
    agentId,
    ephemeralDefinition: null,
    task,
    contextManifest: { version: 1, entries: [], assembledAt: Date.now(), estimatedChars: 0 },
    permissionRestriction: null,
    environment: { version: 1, kind: 'git_worktree' },
    expectedResult: null,
    completionMode: AgentRunCompletionMode.Detach,
    invocationMode: AgentRunInvocationMode.Delegated,
    runTtlMs: null,
    parentRunId: null,
    parentAttemptId: null,
    parentNodeId: 'parent-node',
    parentTurnId: 'parent-turn',
    parentMessageId: 'parent-message',
    parentToolCallId: 'spawn-tool-call',
  };
}

async function waitFor<T>(read: () => T | null, message: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${message}`);
}

describe('Custom Agents real-database lifecycle', () => {
  let root: string;
  let dataDir: string;
  let repositoryCwd: string;
  let assembly: AgentRunAssembly | null;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-custom-agents-e2e-'));
    dataDir = path.join(root, 'data');
    repositoryCwd = path.join(root, 'workspace');
    fs.mkdirSync(repositoryCwd, { recursive: true });
    git(repositoryCwd, 'init', '-q', '-b', 'main');
    git(repositoryCwd, 'config', 'user.email', 'michi-test@example.com');
    git(repositoryCwd, 'config', 'user.name', 'Michi Test');
    fs.writeFileSync(path.join(repositoryCwd, 'base.txt'), 'base\n');
    git(repositoryCwd, 'add', 'base.txt');
    git(repositoryCwd, 'commit', '-q', '-m', 'base');

    process.env.MICHI_DATA_DIR = dataDir;
    process.env.MICHI_CLOUD = '1';
    closeDb();
    initDb();
    getDb().prepare(`INSERT INTO workspaces
      (id,name,cwd,owner_user_id,active_tree_id,created_at,updated_at) VALUES (?,?,?,?,?,1,1)`)
      .run(WORKSPACE, 'Owner workspace', repositoryCwd, OWNER, 'parent-tree');
    getDb().prepare('INSERT INTO workspaces (id,name,cwd,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,1,1)')
      .run(OTHER_WORKSPACE, 'Other workspace', repositoryCwd, OTHER_OWNER);
    getDb().prepare(`INSERT INTO trees
      (id, workspace_id, root_node_id, last_active_at, created_at) VALUES ('parent-tree', ?, 'parent-node', 1, 1)`)
      .run(WORKSPACE);
    getDb().prepare(`INSERT INTO nodes
      (id, workspace_id, tree_id, kind, status, minimized, spawned_by_agent, created_at)
      VALUES ('parent-node', ?, 'parent-tree', 'chat', 'idle', 0, 0, 1)`).run(WORKSPACE);
    getDb().prepare(`INSERT INTO messages
      (id, node_id, role, content, seq, created_at)
      VALUES ('parent-message', 'parent-node', 'assistant', 'Parent answer', 0, 1)`).run();
    getDb().prepare(`INSERT INTO turns
      (turn_id, node_id, assistant_message_id, status, last_seq, started_at, completed_at, updated_at)
      VALUES ('parent-turn', 'parent-node', 'parent-message', 'completed', 0, 1, 1, 1)`).run();
    assembly = null;
  });

  afterEach(async () => {
    await assembly?.shutdown();
    closeDb();
    delete process.env.MICHI_CLOUD;
    delete process.env.MICHI_DATA_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('isolates owners, executes in worktrees, wakes a Parent compactly, and recovers after restart', async () => {
    const catalog = new AgentCapabilityCatalog([], (runtimeId) => runtimeId === 'fixture-runtime');
    const definitions = new AgentDefinitionService({
      capabilityCatalog: catalog,
      repository: new AgentDefinitionsRepository({ capabilityCatalog: catalog }),
      runtimeReadiness: { validate: () => {} },
    });
    const draft = await definitions.create(OWNER, definitionRequest(), 'create-definition');
    const enabled = await definitions.enable(OWNER, draft.id, 'enable-definition');
    assert.equal(enabled?.status, AgentDefinitionStatus.Enabled);
    assert.equal(definitions.get(OTHER_OWNER, draft.id), null);
    assert.deepEqual(definitions.discoverEnabled(OTHER_OWNER, OTHER_WORKSPACE), []);

    const deliveries: Parameters<ParentContinuationSink['deliver']>[0][] = [];
    const parentSink: ParentContinuationSink = {
      deliver: async (input) => { deliveries.push(input); return 'delivered'; },
    };
    const executor = new LifecycleExecutor();
    assembly = createAgentRunAssembly({
      enabled: true,
      dataDir,
      defaultCwd: repositoryCwd,
      definitionService: definitions,
      executor,
      parentSink,
      platformPermissionPolicy: buildPolicy,
      heartbeatIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    await assembly.start();

    const run = await assembly.routeService.spawn(OWNER, spawnRequest(enabled!.id, 'Create agent-output.txt'), 'spawn-first');
    await waitFor(() => assembly!.repository.getRun(OWNER, run.id)?.status === AgentRunStatus.Running ? run : null, 'first Run to start');
    assert.equal(assembly.routeService.getDetail(OTHER_OWNER, run.id), null);
    assert.equal(assembly.routeService.events(OTHER_OWNER, run.id, -1), null);
    assert.equal(assembly.coordinator.check(OTHER_OWNER, run.id), null);
    assert.ok(executor.firstSpec);
    assert.notEqual(executor.firstSpec!.executionEnvironment.cwd, repositoryCwd);
    assert.equal(fs.existsSync(path.join(repositoryCwd, 'agent-output.txt')), false);

    const watch = assembly.routeService.createWatch(OWNER, {
      version: 1,
      workspaceId: WORKSPACE,
      runIds: [run.id],
      condition: { version: 1, kind: 'all' },
      completionMode: 'wake',
      parentRunId: null,
      parentNodeId: 'parent-node',
      parentTurnId: 'parent-turn',
    }, 'watch-first');
    assert.equal(assembly.repository.getWatch(OTHER_OWNER, watch.id), null);

    executor.first.resolve({
      status: 'completed',
      resultBundle: completedBundle(executor.firstSpec!, 'Created the requested file', 'agent-output.txt'),
    });
    const completed = await waitFor(() => {
      const current = assembly!.repository.getRun(OWNER, run.id);
      return current?.status === AgentRunStatus.Completed ? current : null;
    }, 'first Run completion');
    await waitFor(() => deliveries.length === 1 ? deliveries[0] : null, 'Parent Watch delivery');

    assert.equal(completed.executionEnvironment.kind, 'git_worktree');
    assert.ok(completed.resultBundle?.changeSet?.changedFiles.includes('agent-output.txt'));
    assert.equal(fs.readFileSync(path.join(completed.executionEnvironment.cwd, 'agent-output.txt'), 'utf8'), 'Created the requested file\n');
    assert.equal(fs.existsSync(path.join(repositoryCwd, 'agent-output.txt')), false);
    assert.match(deliveries[0].handoff, /Created the requested file/);
    assert.match(deliveries[0].handoff, /agent-output\.txt created in the isolated worktree/);
    assert.doesNotMatch(deliveries[0].handoff, /verbose worker transcript/);
    assert.deepEqual(deliveries[0].runIds, [run.id]);
    assert.equal(assembly.repository.getWatch(OWNER, watch.id)?.status, 'fired');

    const interrupted = await assembly.routeService.spawn(OWNER, spawnRequest(enabled!.id, 'Recover this Run'), 'spawn-restart');
    await waitFor(() => assembly!.repository.getRun(OWNER, interrupted.id)?.status === AgentRunStatus.Running ? interrupted : null, 'restart Run to start');
    const interruptedCwd = executor.interruptedSpec!.executionEnvironment.cwd;
    await assembly.shutdown();
    executor.interrupted.resolve({ status: 'cancelled' });
    assert.equal(assembly.repository.getRun(OWNER, interrupted.id)?.status, AgentRunStatus.Recovering);

    const restartedExecutor = new LifecycleExecutor();
    assembly = createAgentRunAssembly({
      enabled: true,
      dataDir,
      defaultCwd: repositoryCwd,
      definitionService: new AgentDefinitionService({
        capabilityCatalog: catalog,
        repository: new AgentDefinitionsRepository({ capabilityCatalog: catalog }),
        runtimeReadiness: { validate: () => {} },
      }),
      executor: restartedExecutor,
      parentSink,
      platformPermissionPolicy: buildPolicy,
      heartbeatIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    const recovery = await assembly.start();
    assert.equal(recovery.launched, 1);
    const recovered = await waitFor(() => {
      const current = assembly!.repository.getRun(OWNER, interrupted.id);
      return current?.status === AgentRunStatus.Completed ? current : null;
    }, 'recovered Run completion');

    assert.equal(restartedExecutor.resumes, 1);
    assert.deepEqual(restartedExecutor.resumeToken, { cursor: 'resume-cursor-1' });
    assert.equal(restartedExecutor.resumedSpec?.executionEnvironment.cwd, interruptedCwd);
    assert.ok(recovered.resultBundle?.changeSet?.changedFiles.includes('recovered-output.txt'));
    assert.equal(assembly.repository.listAttempts(OWNER, interrupted.id).length, 2);
    assert.ok(assembly.repository.listEvents(OWNER, interrupted.id)
      .some((event) => event.type === AgentRunEventType.RecoveryStarted));
    assert.equal(assembly.repository.listEvents(OTHER_OWNER, interrupted.id).length, 0);
  });
});
