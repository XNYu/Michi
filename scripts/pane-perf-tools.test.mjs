import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareReports,
  formatComparison,
  parseCompareArgs,
} from './compare-pane-perf.mjs';
import { parsePanePerfArgs, runPanePerf } from './run-pane-perf.mjs';

function report(scenarios) {
  return { report: { scenarios } };
}

function scenario(name, values) {
  return {
    name,
    scriptDurationMs: values.script,
    taskDurationMs: values.task,
    interactionMaxMs: values.input,
    frames: {
      avg: values.frameAvg,
      p95: values.frameP95,
      longTaskCount: values.longTasks,
    },
    componentDelta: { MarkdownContent: values.markdown },
  };
}

test('pane perf runner parses repeatable isolated runs', () => {
  assert.deepEqual(
    parsePanePerfArgs(['--label', 'markdown-hz3', '--markdown-hz', '3', '--runs', '2', '--port', '3120']),
    {
      label: 'markdown-hz3',
      markdownHz: 3,
      runs: 2,
      port: 3120,
      outputDir: undefined,
      help: false,
    },
  );
  assert.throws(() => parsePanePerfArgs(['--label', 'bad label']), /may contain only/);
});

test('pane perf runner gives each repeat an isolated port and label', () => {
  const calls = [];
  runPanePerf({
    label: 'sample',
    markdownHz: 3,
    runs: 2,
    port: 3120,
    outputDir: 'e2e/.perf',
  }, (...args) => {
    calls.push(args);
    return { status: 0 };
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0][2].env.MICHI_PERF_LABEL, 'sample-r1');
  assert.equal(calls[1][2].env.MICHI_PERF_LABEL, 'sample-r2');
  assert.equal(calls[0][2].env.E2E_PORT, '3120');
  assert.equal(calls[1][2].env.E2E_PORT, '3121');
  assert.equal(calls[0][2].env.MICHI_MARKDOWN_REINTERPRET_HZ, '3');
});

test('pane perf comparator averages runs and flags regressions', () => {
  const baseline = [
    report([scenario('stream', { script: 100, task: 200, frameAvg: 8, frameP95: 10, longTasks: 0, markdown: 100, input: 20 })]),
    report([scenario('stream', { script: 120, task: 220, frameAvg: 9, frameP95: 12, longTasks: 0, markdown: 110, input: 22 })]),
  ];
  const candidate = [
    report([scenario('stream', { script: 140, task: 240, frameAvg: 10, frameP95: 14, longTasks: 1, markdown: 150, input: 25 })]),
  ];
  const comparison = compareReports(baseline, candidate, { warn: 5, fail: 15 });

  const script = comparison.rows.find((row) => row.metric.label === 'Script CPU');
  assert.equal(script.before.value, 110);
  assert.equal(script.after.value, 140);
  assert.equal(script.status, 'FAIL');
  assert.equal(comparison.failed, true);
  assert.match(formatComparison(comparison, { warn: 5, fail: 15 }), /stream \| Script CPU \| 110\.0ms \(n=2\) \| 140\.0ms \(n=1\) \| \+27\.3% \| FAIL/);
});

test('comparator accepts multiple report paths and report-only mode', () => {
  const options = parseCompareArgs([
    '--baseline', 'before-r1.json', 'before-r2.json',
    '--candidate', 'after-r1.json',
    '--warn', '4', '--fail', '10', '--no-fail',
  ]);
  assert.deepEqual(options, {
    baseline: ['before-r1.json', 'before-r2.json'],
    candidate: ['after-r1.json'],
    warn: 4,
    fail: 10,
    noFail: true,
    help: false,
  });
});
