import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { isReasoningLevel, sanitizeReasoningLevels } from 'michi-shared';
import type { ModelInfo } from '../../contract/types';
import { findClaudeBinary, preflightClaudeAuth } from './claudeBinary';
import { spawnAgentProcess, killProcessTree } from '../../core/processTree';
import type { ClaudeAdapterOptions } from './claudeAdapterOptions';
import { loadClaudeSdk, type ClaudeSdkModule } from './claudeSdkTransport';
import { withDeadline } from '../../core/runtimeLifecycle';

/**
 * Asks the installed Claude CLI which models the current account can use.
 *
 * The CLI answers the stream-json `initialize` control request with a
 * `models` array (the same list its own `/model` picker shows). Nothing is
 * sent to the model API, so the probe works without a valid model session;
 * it costs one CLI start-up (a few seconds), which is why ClaudeRuntime only
 * runs it once per backend start and otherwise serves the disk cache.
 */

export const CLAUDE_MODEL_PROBE_TIMEOUT_MS = 30_000;
const MAX_MODELS = 200;
const MAX_LABEL_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 300;
// Model ids end up in `--model <id>` argv (no shell), but they still come from
// another process: keep them to the characters real ids use, e.g.
// `global.anthropic.claude-opus-5-5[1m]`.
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,199}$/;
export interface ClaudeModelProbeOptions {
  timeoutMs?: number;
  cwd?: string;
  /** Test seam: no hand-written wire implementation in production. */
  sdk?: Pick<ClaudeSdkModule, 'query'>;
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Map the `initialize` response body onto Michi's ModelInfo.
 *
 * The id is the CLI's `resolvedModel` (a concrete id such as `claude-fable-5`)
 * rather than its picker `value` (which can be a short alias like `fable`):
 * some CLI distributions do not resolve short aliases passed through `--model`.
 * The CLI's `default` entry becomes an ordinary entry flagged `isDefault`.
 */
export function parseClaudeInitializeModels(response: unknown): ModelInfo[] {
  if (!response || typeof response !== 'object') return [];
  const rawModels = (response as { models?: unknown }).models;
  if (!Array.isArray(rawModels)) return [];

  const byId = new Map<string, ModelInfo>();
  for (const item of rawModels) {
    if (byId.size >= MAX_MODELS) break;
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const value = boundedString(raw.value, 200);
    const id = boundedString(raw.resolvedModel, 200) ?? value;
    if (!id || !MODEL_ID_PATTERN.test(id)) continue;

    const isDefault = value === 'default';
    const existing = byId.get(id);
    if (existing) {
      if (isDefault) byId.set(id, { ...existing, isDefault: true });
      continue;
    }

    const levels = raw.supportsEffort === true
      ? sanitizeReasoningLevels(raw.supportedEffortLevels) ?? []
      : [];
    const defaultReasoning = levels.includes('high') ? 'high' : levels[0];
    byId.set(id, {
      id,
      label: boundedString(raw.displayName, MAX_LABEL_CHARS) ?? id,
      description: boundedString(raw.description, MAX_DESCRIPTION_CHARS),
      ...(isDefault ? { isDefault: true } : {}),
      supportsReasoning: levels.length > 0,
      supportedReasoningLevels: levels,
      ...(isReasoningLevel(defaultReasoning) ? { defaultReasoning } : {}),
    });
  }
  return [...byId.values()];
}

/**
 * The adapter options the probe reads: the config dir, the host's data dir
 * (for its neutral cwd), and the environment and binary of the CLI it starts.
 */
export type ClaudeModelProbeConfig = Pick<ClaudeAdapterOptions, 'host' | 'spawnEnv' | 'binaryPath' | 'configDir'>;

/**
 * Keep model discovery away from workspace settings and CLAUDE.md. Use a
 * stable data-dir folder because the toolbox CLI can stall in the OS temp dir.
 */
function defaultClaudeModelProbeCwd(config: ClaudeModelProbeConfig): string {
  const dir = path.join(config.host.config.dataDir(), 'model-probe-cwd');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** SDK discovery uses a neutral cwd, no model turn and no session persistence. */
export async function probeClaudeModels(config: ClaudeModelProbeConfig, opts: ClaudeModelProbeOptions = {}): Promise<ModelInfo[]> {
  const configDir = config.configDir?.();
  const spawnEnv = config.spawnEnv();
  preflightClaudeAuth(configDir, spawnEnv);
  const binary = findClaudeBinary(config.binaryPath());
  const sdk = opts.sdk ?? await loadClaudeSdk();
  let child: ChildProcessWithoutNullStreams | undefined;
  let query: Query | undefined;
  try {
    query = sdk.query({ prompt: '', options: {
      cwd: opts.cwd ?? defaultClaudeModelProbeCwd(config),
      pathToClaudeCodeExecutable: binary,
      persistSession: false,
      extraArgs: { bare: null },
      env: { ...spawnEnv, ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}) },
      spawnClaudeCodeProcess: (args) => {
        child = spawnAgentProcess(args.command, args.args, { cwd: args.cwd, env: args.env, signal: args.signal });
        return child;
      },
    } });
    const timeoutMs = opts.timeoutMs ?? CLAUDE_MODEL_PROBE_TIMEOUT_MS;
    const response = await withDeadline(query.initializationResult(), timeoutMs, `claude model probe timed out after ${timeoutMs}ms`);
    return parseClaudeInitializeModels(response);
  } finally {
    try { query?.close(); } finally {
      if (child?.pid) killProcessTree(child.pid, 'SIGKILL');
    }
  }
}
