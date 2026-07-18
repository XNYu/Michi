# Pane Performance Benchmarks

The pane benchmark is a deterministic, browser-renderer performance suite. It uses a mock SSE stream and a seeded Markdown-heavy workspace, so it measures rendering work without needing a real model or backend.

It exercises four-pane and six-pane workspaces, horizontal scrolling, streaming into one active pane, inactive-pane render isolation, input focus switches, and heap snapshots after pane closes.

## Run a benchmark

Run from the repository root. `--label` becomes part of the JSON output filename.

```bash
npm run perf:pane -- --label markdown-hz3 --markdown-hz 3 --runs 2
```

Each repetition writes `e2e/.perf/pane-performance-markdown-hz3-r1.json`, then `...-r2.json`. The runner uses an isolated Vite port starting at `3101`, avoiding accidental reuse of a developer server on port `3001`.

Useful options:

```text
--markdown-hz <0..60>  Override the Markdown reinterpretation rate.
--runs <count>         Repeat the suite; use at least 2 for a comparison.
--port <port>          First isolated port; repetitions use consecutive ports.
--output-dir <path>    Store JSON somewhere other than e2e/.perf.
```

For an old-vs-new Markdown A/B:

```bash
npm run perf:pane -- --label markdown-hz0 --markdown-hz 0 --runs 2 --port 3120
npm run perf:pane -- --label markdown-hz3 --markdown-hz 3 --runs 2 --port 3130
```

## Compare JSON reports

```bash
npm run perf:compare -- \
  --baseline e2e/.perf/pane-performance-markdown-hz0-r1.json e2e/.perf/pane-performance-markdown-hz0-r2.json \
  --candidate e2e/.perf/pane-performance-markdown-hz3-r1.json e2e/.perf/pane-performance-markdown-hz3-r2.json
```

The comparison aggregates each scenario across the supplied runs and reports means for Script CPU, Renderer task time, frame average, frame p95, long-task count, Markdown render count, and input latency.

All listed metrics are lower-is-better. By default a +5% regression is `WARN`, and a +15% regression is `FAIL` with a nonzero exit code. Tune the thresholds or make it report-only:

```bash
npm run perf:compare -- --baseline before.json --candidate after.json --warn 3 --fail 8
npm run perf:compare -- --baseline before.json --candidate after.json --no-fail
```

## Scope and limitations

This measures the browser renderer through Playwright and Chrome DevTools Protocol. It includes JavaScript CPU time, renderer task time, heap snapshots, animation-frame timing, long tasks, and application render counters.

It does not measure Electron's GPU process, system-wide CPU in Activity Monitor, or real model/network timing. Use it to catch renderer regressions and compare frontend alternatives; use a separate Electron/system profiler for whole-app CPU questions.
