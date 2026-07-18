#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const DEFAULT_WARN_PERCENT = 5;
const DEFAULT_FAIL_PERCENT = 15;

const METRICS = [
  { label: 'Script CPU', unit: 'ms', value: (scenario) => scenario.scriptDurationMs },
  { label: 'Renderer task', unit: 'ms', value: (scenario) => scenario.taskDurationMs },
  { label: 'Frame average', unit: 'ms', value: (scenario) => scenario.frames?.avg },
  { label: 'Frame p95', unit: 'ms', value: (scenario) => scenario.frames?.p95 },
  { label: 'Long tasks', unit: '', value: (scenario) => scenario.frames?.longTaskCount },
  { label: 'Markdown renders', unit: '', value: (scenario) => scenario.componentDelta?.MarkdownContent },
  { label: 'Input max', unit: 'ms', value: (scenario) => scenario.interactionMaxMs },
];

function usage() {
  return `Usage: npm run perf:compare -- --baseline <file...> --candidate <file...> [options]

Options:
  --warn <percent>  Warning threshold for a worse metric (default: ${DEFAULT_WARN_PERCENT}).
  --fail <percent>  Failure threshold for a worse metric (default: ${DEFAULT_FAIL_PERCENT}).
  --no-fail         Report failures but exit successfully.
  --help            Show this help.

Example:
  npm run perf:compare -- \\
    --baseline e2e/.perf/before-r1.json e2e/.perf/before-r2.json \\
    --candidate e2e/.perf/after-r1.json e2e/.perf/after-r2.json`;
}

function number(value, option, min) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) throw new Error(`${option} must be a number >= ${min}`);
  return parsed;
}

export function parseCompareArgs(argv) {
  const options = {
    baseline: [],
    candidate: [],
    warn: DEFAULT_WARN_PERCENT,
    fail: DEFAULT_FAIL_PERCENT,
    noFail: false,
    help: false,
  };
  let target = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      options.help = true;
    } else if (arg === '--baseline') {
      target = options.baseline;
    } else if (arg === '--candidate') {
      target = options.candidate;
    } else if (arg === '--warn' || arg === '--fail') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = number(value, arg, 0);
      index += 1;
    } else if (arg === '--no-fail') {
      options.noFail = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (target) {
      target.push(arg);
    } else {
      throw new Error(`Expected --baseline or --candidate before ${arg}`);
    }
  }

  if (!options.help && (options.baseline.length === 0 || options.candidate.length === 0)) {
    throw new Error('--baseline and --candidate each require at least one file');
  }
  if (options.fail < options.warn) throw new Error('--fail must be greater than or equal to --warn');
  return options;
}

export function readReports(files) {
  return files.map((file) => {
    const report = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(report.scenarios)) throw new Error(`${file} does not contain a scenarios array`);
    return { file, report };
  });
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function aggregateReports(reports) {
  const scenarios = new Map();
  for (const { report } of reports) {
    for (const scenario of report.scenarios) {
      if (!scenario?.name) continue;
      const rows = scenarios.get(scenario.name) ?? [];
      rows.push(scenario);
      scenarios.set(scenario.name, rows);
    }
  }
  return scenarios;
}

function metricMean(rows, metric) {
  const values = rows.map(metric.value).filter(Number.isFinite);
  return values.length > 0 ? { value: mean(values), count: values.length } : null;
}

export function compareReports(baselineReports, candidateReports, thresholds) {
  const baseline = aggregateReports(baselineReports);
  const candidate = aggregateReports(candidateReports);
  const names = [...new Set([...baseline.keys(), ...candidate.keys()])].sort();
  const rows = [];
  let failed = false;

  for (const name of names) {
      const baselineScenario = baseline.get(name);
      const candidateScenario = candidate.get(name);
    for (const metric of METRICS) {
      const before = baselineScenario && metricMean(baselineScenario, metric);
      const after = candidateScenario && metricMean(candidateScenario, metric);
      if (!before && !after) continue;
      if (!before || !after) {
        rows.push({ name, metric, before, after, change: null, status: 'MISSING' });
        continue;
      }

      let change = null;
      let status = 'OK';
      if (before.value === 0) {
        if (after.value > 0) {
          status = 'FAIL';
          failed = true;
        }
      } else {
        change = ((after.value - before.value) / before.value) * 100;
        if (change > thresholds.fail) {
          status = 'FAIL';
          failed = true;
        } else if (change > thresholds.warn) {
          status = 'WARN';
        }
      }
      rows.push({ name, metric, before, after, change, status });
    }
  }
  return { rows, failed };
}

function fmtValue(metric, measurement) {
  if (!measurement) return 'n/a';
  const value = measurement.value;
  const text = metric.unit === 'ms'
    ? `${value.toFixed(1)}ms`
    : Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${text} (n=${measurement.count})`;
}

function fmtChange(change) {
  if (change === null) return 'n/a';
  return `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`;
}

export function formatComparison(comparison, options) {
  const lines = [
    'Pane performance comparison',
    `Thresholds: warn > +${options.warn}% · fail > +${options.fail}% (higher is worse)`,
    '',
    'Scenario | Metric | Baseline mean | Candidate mean | Change | Status',
    '--- | --- | ---: | ---: | ---: | ---',
  ];
  for (const row of comparison.rows) {
    lines.push([
      row.name,
      row.metric.label,
      fmtValue(row.metric, row.before),
      fmtValue(row.metric, row.after),
      fmtChange(row.change),
      row.status,
    ].join(' | '));
  }
  return lines.join('\n');
}

function main() {
  try {
    const options = parseCompareArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const comparison = compareReports(
      readReports(options.baseline),
      readReports(options.candidate),
      options,
    );
    console.log(formatComparison(comparison, options));
    if (comparison.failed && !options.noFail) process.exitCode = 1;
  } catch (error) {
    console.error(`pane performance comparison: ${error.message}`);
    console.error(usage());
    process.exitCode = 1;
  }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) main();
