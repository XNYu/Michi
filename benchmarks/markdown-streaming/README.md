# Markdown streaming benchmark

Compares Michi and Streamdown 2.5.0 in Chromium under identical fixtures,
chunk sizes, requestAnimationFrame pacing, and warm-up. The current suite
measures both renderer-focused and full-feature profiles:

- Michi 3Hz core
- Michi 3Hz with CJK, semantic strikethrough, code line numbers/download,
  table controls, Mermaid, automatic direction, link safety, and HTML
  indentation normalization
- Streamdown's full component/plugin layer driven by Michi's 3Hz semantic
  snapshots and lightweight pending tail
- Streamdown Word core
- Streamdown Word with its equivalent full feature set
- Streamdown Char with its equivalent full feature set

```bash
npm install --prefix benchmarks/markdown-streaming --package-lock=false --ignore-scripts
node benchmarks/markdown-streaming/run.mjs
```

Focused hybrid component tests:

```bash
cd benchmarks/markdown-streaming
../../node_modules/.bin/vitest run --config vitest.config.mts
```

Optional environment variables:

- `MICHI_MARKDOWN_BENCH_REPEATS` (default `3`, range `1..10`)
- `MICHI_MARKDOWN_BENCH_PORT` (default `4317`)
- `MICHI_MARKDOWN_BENCH_FIXTURES` (optional comma-separated fixture ids)
- `MICHI_MARKDOWN_BENCH_NO_WRITE=1` (validate a run without replacing reports)

Results are written to `benchmarks/markdown-streaming/results/latest.{json,md}`
and `hybrid-snapshot-comparison.{json,md}`. Immutable dated artifacts preserve
the strategy baseline and completed comparisons separately.
