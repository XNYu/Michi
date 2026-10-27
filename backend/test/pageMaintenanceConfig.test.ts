// Must stay first: agentConfig would otherwise persist these fixtures to ~/.michi/config.json.
import './isolatedConfigDir';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { updateAgentConfig } from '../src/services/agentConfig';
import { PageWriteError } from '../src/services/pages/core';
import { PageMaintenanceConfigService } from '../src/services/pages/maintenanceConfig';
import { createMaintenanceConfig, getMaintenanceConfig } from '../src/services/pages/maintenanceRepository';
import { getMaintenanceWorkspaceView } from '../src/services/pages/maintenanceRouting';
import { ScheduledJobEventBus } from '../src/services/scheduledJobs/events';
import { ScheduledJobsRepository } from '../src/services/scheduledJobs/repository';
import { ScheduledJobScheduler, type ScheduledJobExecutor } from '../src/services/scheduledJobs/scheduler';

let dir: string;
let priorDataDir: string | undefined;
let priorCloud: string | undefined;
let now: number;

const NO_PROFILE = { runtimeId: null, providerId: null, modelId: null, reasoning: null };

beforeEach(() => {
  priorDataDir = process.env.MICHI_DATA_DIR;
  priorCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-page-maintenance-config-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb(); now = 100;
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?)').run('ws', 'Workspace', 'local-user', now, now);
});

afterEach(() => {
  closeDb();
  if (priorDataDir === undefined) delete process.env.MICHI_DATA_DIR;
  else process.env.MICHI_DATA_DIR = priorDataDir;
  if (priorCloud === undefined) delete process.env.MICHI_CLOUD;
  else process.env.MICHI_CLOUD = priorCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

function scheduler(): ScheduledJobScheduler {
  const executor: ScheduledJobExecutor = { start: async () => { throw new Error('not used'); } };
  return new ScheduledJobScheduler({ repository: new ScheduledJobsRepository(), executor,
    events: new ScheduledJobEventBus(() => now), workspaceExists: () => true, runtimeExists: () => true,
    clock: () => now, createId: () => 'maintenance-job' });
}

const profileOf = (row: { runtimeId: string | null; providerId: string | null; modelId: string | null; reasoning: string | null }) =>
  ({ runtimeId: row.runtimeId, providerId: row.providerId, modelId: row.modelId, reasoning: row.reasoning });

test('enabling stores no runtime profile in the config or its job, whatever the global runtime is', () => {
  // Kiro was refused here before; whether a runtime can run is now decided when a run starts.
  updateAgentConfig({ runtime: 'kiro', modelByRuntime: { kiro: 'kiro-model' } });
  const jobs = scheduler();
  const service = new PageMaintenanceConfigService(jobs, () => ++now);
  const { config, job } = service.enable({ workspaceId: 'ws', ownerUserId: 'local-user' });
  assert.deepEqual(profileOf(config), NO_PROFILE);
  assert.deepEqual(profileOf(job), NO_PROFILE);

  const paused = service.enable({ workspaceId: 'ws', ownerUserId: 'local-user', expectedRevision: config.revision, paused: true });
  assert.deepEqual(profileOf(paused.config), NO_PROFILE);
  assert.deepEqual(profileOf(jobs.getJob(job.id)), NO_PROFILE);
  assert.equal(jobs.getJob(job.id).enabled, false);
});

test('a runtime choice for one workspace is refused; explicit nulls are accepted', () => {
  const jobs = scheduler();
  const service = new PageMaintenanceConfigService(jobs, () => ++now);
  assert.throws(() => service.enable({ workspaceId: 'ws', ownerUserId: 'local-user', runtimeId: 'pi' }),
    (error: unknown) => error instanceof PageWriteError && error.status === 400 && /Meta agent/.test(error.message));
  assert.equal(getMaintenanceConfig('ws', 'local-user'), null, 'nothing was created');

  const { config } = service.enable({ workspaceId: 'ws', ownerUserId: 'local-user', ...NO_PROFILE });
  for (const field of ['runtimeId', 'providerId', 'modelId', 'reasoning'] as const) {
    assert.throws(() => service.update({ workspaceId: 'ws', ownerUserId: 'local-user', expectedRevision: config.revision,
      now: ++now, [field]: 'x' }), PageWriteError, field);
  }
  assert.equal(getMaintenanceConfig('ws', 'local-user')!.revision, config.revision, 'a refused update changes nothing');
  const updated = service.update({ workspaceId: 'ws', ownerUserId: 'local-user', expectedRevision: config.revision,
    now: ++now, paused: true, ...NO_PROFILE });
  assert.equal(updated.paused, true);
});

test('any update clears a runtime profile an older config or job still carries', () => {
  const jobs = scheduler();
  const job = jobs.createJob({ workspaceId: 'ws', name: 'Space maintenance', prompt: 'Maintain spaces',
    schedule: { kind: 'every', everySeconds: 60 }, permissionMode: 'trust', sessionMode: 'fresh' });
  const initial = createMaintenanceConfig({ workspaceId: 'ws', ownerUserId: 'local-user', jobId: job.id, now, enabled: true });
  assert.deepEqual(profileOf(initial), NO_PROFILE);
  getDb().prepare("UPDATE page_maintenance_configs SET runtime_id='pi', provider_id='old-provider', model_id='old-model', reasoning='minimal'").run();
  getDb().prepare("UPDATE scheduled_jobs SET runtime_id='pi', provider_id='old-provider', model_id='old-model', reasoning='minimal' WHERE id=?").run(job.id);

  const service = new PageMaintenanceConfigService(jobs, () => ++now);
  const paused = service.update({ workspaceId: 'ws', ownerUserId: 'local-user', expectedRevision: initial.revision, now: ++now, paused: true });
  assert.deepEqual(profileOf(paused), NO_PROFILE);
  assert.deepEqual(profileOf(jobs.getJob(job.id)), NO_PROFILE);
});

test('the migration clears every copied runtime profile and keeps revisions', () => {
  const jobs = scheduler();
  const job = jobs.createJob({ workspaceId: 'ws', name: 'Space maintenance', prompt: 'Maintain spaces',
    schedule: { kind: 'every', everySeconds: 60 }, permissionMode: 'trust', sessionMode: 'fresh' });
  createMaintenanceConfig({ workspaceId: 'ws', ownerUserId: 'local-user', jobId: job.id, now, enabled: true });
  getDb().prepare('INSERT INTO scheduled_jobs(id,workspace_id,name,prompt,schedule,runtime_id,model_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,1)')
    .run('ordinary-job', 'ws', 'Daily', 'Summarize', JSON.stringify({ kind: 'every', everySeconds: 3600 }), 'codex', 'gpt-x');
  getDb().prepare("UPDATE page_maintenance_configs SET runtime_id='pi', provider_id='old-provider', model_id='old-model', reasoning='minimal', revision=3").run();
  getDb().prepare("UPDATE scheduled_jobs SET runtime_id='pi', provider_id='old-provider', model_id='old-model', reasoning='minimal' WHERE id=?").run(job.id);

  getDb().prepare("DELETE FROM schema_migrations WHERE version='0038_meta_agent_runtime'").run();
  closeDb(); initDb();
  const config = getMaintenanceConfig('ws', 'local-user')!;
  assert.deepEqual(profileOf(config), NO_PROFILE);
  assert.equal(config.revision, 3);
  assert.deepEqual(profileOf(scheduler().getJob(job.id)), NO_PROFILE);
  const ordinary = getDb().prepare("SELECT runtime_id, model_id FROM scheduled_jobs WHERE id='ordinary-job'").get();
  assert.deepEqual({ ...ordinary }, { runtime_id: 'codex', model_id: 'gpt-x' }, 'other jobs keep their runtime');
});

test('the workspace view reports the runtime the next run resolves to, not the config\'s', () => {
  const jobs = scheduler();
  new PageMaintenanceConfigService(jobs, () => ++now).enable({ workspaceId: 'ws', ownerUserId: 'local-user' });
  const view = () => getMaintenanceWorkspaceView({ workspaceId: 'ws', ownerUserId: 'local-user', scheduler: jobs, now });
  updateAgentConfig({ runtime: 'pi' });
  assert.equal(view().scheduler, 'available');
  assert.deepEqual({ runtimeId: view().runtime?.runtimeId, followsGlobal: view().runtime?.followsGlobal }, { runtimeId: 'pi', followsGlobal: true });
  updateAgentConfig({ runtime: 'gemini' });
  assert.equal(view().scheduler, 'unavailable');
  assert.equal(view().runtime?.runtimeId, 'gemini');
});
