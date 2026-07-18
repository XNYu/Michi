#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const DEFAULT_PORT = 3101;

function usage() {
  return `Usage: npm run perf:pane -- --label <name> [options]

Options:
  --markdown-hz <0..60>  Override Markdown snapshot frequency.
  --runs <count>         Repeat the benchmark (default: 1).
  --port <port>          First isolated Vite port (default: ${DEFAULT_PORT}).
  --output-dir <path>    Directory for JSON result files.
  --help                 Show this help.

Examples:
  npm run perf:pane -- --label before --markdown-hz 0 --runs 2
  npm run perf:pane -- --label after --markdown-hz 3 --runs 2 --port 3120`;
}

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function integer(value, option, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${option} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

export function parsePanePerfArgs(argv) {
  const options = {
    label: undefined,
    markdownHz: undefined,
    runs: 1,
    port: DEFAULT_PORT,
    outputDir: undefined,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      options.help = true;
    } else if (arg === '--label') {
      options.label = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--markdown-hz' || arg === '--hz') {
      options.markdownHz = integer(requireValue(argv, index, arg), arg, 0, 60);
      index += 1;
    } else if (arg === '--runs') {
      options.runs = integer(requireValue(argv, index, arg), arg, 1, 20);
      index += 1;
    } else if (arg === '--port') {
      options.port = integer(requireValue(argv, index, arg), arg, 1024, 65535);
      index += 1;
    } else if (arg === '--output-dir') {
      options.outputDir = requireValue(argv, index, arg);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.help && !options.label) throw new Error('--label is required');
  if (options.label && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(options.label)) {
    throw new Error('--label may contain only letters, numbers, dot, underscore, and hyphen');
  }
  if (options.port + options.runs - 1 > 65535) {
    throw new Error('--port plus --runs exceeds 65535');
  }
  return options;
}

export function runPanePerf(options, spawn = spawnSync) {
  const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  for (let index = 0; index < options.runs; index += 1) {
    const label = options.runs === 1 ? options.label : `${options.label}-r${index + 1}`;
    const port = options.port + index;
    const env = {
      ...process.env,
      MICHI_PANE_PERF: '1',
      MICHI_PERF_LABEL: label,
      E2E_PORT: String(port),
    };
    if (options.markdownHz !== undefined) env.MICHI_MARKDOWN_REINTERPRET_HZ = String(options.markdownHz);
    if (options.outputDir) env.MICHI_PERF_OUT = resolve(options.outputDir);

    console.log(`\n[pane-perf] run ${index + 1}/${options.runs}: label=${label} port=${port}`);
    const result = spawn(executable, [
      'playwright',
      'test',
      '--config', 'e2e/playwright.config.ts',
      'pane-performance.spec.ts',
      '--workers=1',
    ], { cwd: process.cwd(), env, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status ?? 1;
    if (process.exitCode) return;
  }
}

function main() {
  try {
    const options = parsePanePerfArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    runPanePerf(options);
  } catch (error) {
    console.error(`pane performance runner: ${error.message}`);
    console.error(usage());
    process.exitCode = 1;
  }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) main();
