# Michi and Streamdown functional-gap audit

Date: 2026-08-05

Compared implementations:

- Michi's current React Markdown renderer and streaming Remend tail
- Streamdown 2.5.0 with `@streamdown/code` 1.1.1, `@streamdown/math` 1.0.2,
  `@streamdown/cjk` 1.0.3, and `@streamdown/mermaid` 1.0.2

## Functional comparison

Capability | Michi core before this experiment | Streamdown full profile | Michi opt-in full profile after this experiment
--- | --- | --- | ---
GFM tables, task lists, autolinks, footnotes | Yes | Yes | Yes
Math rendering | KaTeX, with currency/template guards | Math plugin | Unchanged
Syntax-highlighted fenced code | Shiki, language header, copy | Code plugin, copy | Adds line numbers and download
Raw HTML | Parsed only when needed, sanitized | Supported | Adds indentation normalization
Incomplete Markdown while streaming | Remend tail plus periodic semantic snapshots | `parseIncompleteMarkdown` | Unchanged Remend path
CJK emphasis around punctuation | No | CJK plugin | Added CJK-friendly emphasis parsing
Semantic strikethrough | Rendered literal `~~` markers | `<del>` | Optional semantic `<del>`
Table actions | No | Copy, download, fullscreen | Added copy, download, fullscreen
Mermaid | No | SVG, copy, download, fullscreen, pan/zoom | Added lazy SVG, copy, download, fullscreen, zoom
Automatic text direction | No explicit direction | `dir="auto"` | Optional `dir="auto"`
External-link confirmation | No | Link-safety confirmation | Optional confirmation
Streaming caret | Character reveal in the pending tail, no separate caret | Configurable block caret | Keeps Michi's tail reveal; no separate block caret
Bare URL and internal file-link handling | Yes | Standard links plus link safety | Unchanged

The full-profile benchmark therefore aligns the expensive and user-visible
feature surfaces, but it is not an assertion that the two DOMs or interactions
are identical. In particular, Michi does not implement drag-to-pan for Mermaid
and does not add Streamdown's separate block caret. These omissions should have
small cost compared with parsing, syntax highlighting, diagram rendering, and
the controls already included in the measurement.

## Implementation policy

All newly added Michi capabilities are behind `MarkdownFeatureProfile` and are
off by default. Production remains on the existing Michi 3Hz core renderer.
Mermaid is dynamically imported only when the profile enables it and a Mermaid
fence is actually rendered.

## Full-profile benchmark result

The benchmark contains 270 measurements: six fixtures, 128 and 512 characters
per update, static and streaming phases, five renderer profiles, and three
repeats summarized by median.

Mode | Streaming task CPU, 128 chars/update | Streaming task CPU, 512 chars/update | Worst frame p95, 128 / 512
--- | ---: | ---: | ---:
Michi 3Hz core | 2087.5 ms | 966.4 ms | 16.6 / 9.3 ms
Michi 3Hz full | 1947.1 ms | 941.9 ms | 9.3 / 9.2 ms
Streamdown Word core | 8927.6 ms | 3602.0 ms | 58.6 / 58.6 ms
Streamdown Word full | 9560.4 ms | 3836.9 ms | 58.6 / 65.9 ms
Streamdown Char full | 18635.5 ms | 8351.5 ms | 91.8 / 116.6 ms

Across all fixtures, Michi full used 79.6% less task CPU than Streamdown Word
full at 128 characters/update and 75.5% less at 512 characters/update. Against
Streamdown Char full, the reductions were 89.6% and 88.7%.

On the dedicated full-feature fixture, enabling the new features increased
Michi CPU by 41% at 128 characters/update and 55% at 512. The same transition
increased Streamdown Word CPU by 99% and 263%. Michi full still used about
71% to 77% less CPU than Streamdown Word full on that fixture.

Static full-document rendering is much closer and varies by fixture. The clear
advantage is specifically the streaming architecture: Michi displays the cheap
tail immediately while limiting full semantic reparses to 3Hz.

## Artifact integrity

Artifact | SHA-256
--- | ---
`2026-08-05-five-strategy-baseline.json` | `eeebc75b3c716801e56c7ddef4fbdd540f300d39037bed939c55831b8add43c1`
`2026-08-05-five-strategy-baseline.md` | `14d0f1e6ca728ab9d3ff5e2019b2f89b7ff72ef92ecfd4b4797021f2ab79b835`
`2026-08-05-full-feature-parity.json` | `7a146c744ecf7ea15deb66b582a99c74e4983c860702c9e0cd11ebe12db8b89c`
`2026-08-05-full-feature-parity.md` | `83156ee11a2f57fcb888cf058fdad7f08cb74f688b880988c08087ca5bf9853d`

## Reproduction

```bash
npm install --prefix benchmarks/markdown-streaming --package-lock=false --ignore-scripts
node benchmarks/markdown-streaming/run.mjs
```

The run updates `results/latest.{json,md}` and
`results/feature-parity-comparison.{json,md}`. The dated artifacts above are
immutable snapshots of the reported runs.
