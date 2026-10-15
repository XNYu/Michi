import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isReasoningLevel, sanitizeReasoningLevels } from 'michi-shared';
import type { ModelInfo } from '../types';
import { findClaudeBinary, preflightClaudeAuth } from './claudeBinary';
import { spawnAgentProcess, killProcessTree } from '../processTree';
import { resolveClaudeConfigDir } from '../../services/agentConfig';
import { getMichiDataDir } from '../../services/dataDir';

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
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_MODELS = 200;
const MAX_LABEL_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 300;
// Model ids end up in `--model <id>` argv (no shell), but they still come from
// another process: keep them to the characters real ids use, e.g.
// `global.anthropic.claude-opus-5-5[1m]`.
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,199}$/;
const PROBE_REQUEST_ID = 'michi-model-probe';

/**
 * `--bare` skips hooks, plugins and CLAUDE.md discovery so the probe has no
 * side effects (SessionStart hooks would otherwise run on every Michi start).
 * The model list is the same with and without it. `--no-session-persistence`
 * keeps the probe out of `~/.claude` session storage.
 */
export const CLAUDE_MODEL_PROBE_ARGV: readonly string[] = [
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--print',
  '--bare',
  '--no-session-persistence',
];

export interface ClaudeModelProbeOptions {
  timeoutMs?: number;
  /** Neutral cwd; defaults to an empty folder under the Michi data dir. */
  cwd?: string;
  /** Test seam. */
  spawn?: (binary: string, argv: string[], cwd: string) => ChildProcessWithoutNullStreams;
}

export type ClaudeModelProbe = () => Promise<ModelInfo[]>;

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

function defaultSpawn(binary: string, argv: string[], cwd: string): ChildProcessWithoutNullStreams {
  const configDir = resolveClaudeConfigDir();
  return spawnAgentProcess(binary, argv, {
    cwd,
    env: {
      ...process.env,
      ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
    },
  });
}

/**
 * Keep model discovery away from workspace settings and CLAUDE.md. Use a
 * stable data-dir folder because the toolbox CLI can stall in the OS temp dir.
 */
function defaultClaudeModelProbeCwd(): string {
  const dir = path.join(getMichiDataDir(), 'model-probe-cwd');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Spawn the CLI, send `initialize`, and resolve with the parsed model list.
 * The process is always killed once the response (or a failure) arrives.
 */
export async function probeClaudeModels(opts: ClaudeModelProbeOptions = {}): Promise<ModelInfo[]> {
  preflightClaudeAuth(resolveClaudeConfigDir());
  const binary = findClaudeBinary();
  const spawn = opts.spawn ?? defaultSpawn;
  const cwd = opts.cwd ?? defaultClaudeModelProbeCwd();
  const timeoutMs = opts.timeoutMs ?? CLAUDE_MODEL_PROBE_TIMEOUT_MS;

  const child = spawn(binary, [...CLAUDE_MODEL_PROBE_ARGV], cwd);

  return new Promise<ModelInfo[]>((resolve, reject) => {
    let settled = false;
    let buffer = '';
    let bytes = 0;
    let stderrTail = '';

    const finish = (err: Error | null, models?: ModelInfo[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* already closed */ }
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { killProcessTree(child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      if (err) reject(err);
      else resolve(models ?? []);
    };

    const timer = setTimeout(() => {
      finish(new Error(`claude model probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    const handleLine = (line: string) => {
      if (!line.includes('control_response')) return;
      let envelope: unknown;
      try { envelope = JSON.parse(line); } catch { return; }
      if (!envelope || typeof envelope !== 'object') return;
      const env = envelope as { type?: unknown; response?: Record<string, unknown> };
      if (env.type !== 'control_response' || !env.response) return;
      if (env.response.request_id !== PROBE_REQUEST_ID) return;
      if (env.response.subtype !== 'success') {
        const detail = typeof env.response.error === 'string' ? env.response.error : 'unknown error';
        finish(new Error(`claude initialize failed: ${detail}`));
        return;
      }
      finish(null, parseClaudeInitializeModels(env.response.response));
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_STDOUT_BYTES) {
        finish(new Error('claude model probe output exceeded size limit'));
        return;
      }
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1 && !settled) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2_000);
    });
    child.once('error', (err) => finish(err));
    child.once('close', (code) => {
      if (buffer) handleLine(buffer);
      const lastLine = stderrTail.trim().split('\n').pop() ?? '';
      finish(new Error(`claude exited (code ${code}) before answering initialize${lastLine ? `: ${lastLine}` : ''}`));
    });
    child.stdin.on('error', () => { /* child exited before reading stdin */ });
    child.stdin.write(`${JSON.stringify({
      type: 'control_request',
      request_id: PROBE_REQUEST_ID,
      request: { subtype: 'initialize' },
    })}\n`);
  });
}
