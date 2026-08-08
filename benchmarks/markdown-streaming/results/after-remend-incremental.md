# Michi vs Streamdown local benchmark

Generated: 2026-08-05T09:28:16.254Z
Browser: 148.0.7778.96
Machine: darwin / arm64
Streamdown: 2.5.0; repeats: 3; paced updates: one per requestAnimationFrame

## Suite summary (sum of fixture medians)

Suite | Michi task CPU | Streamdown core | core / Michi | Streamdown featured | featured / Michi
--- | ---: | ---: | ---: | ---: | ---:
Streaming, 128 chars/update | 1821.0ms | 4742.3ms | 2.60x | 7058.3ms | 3.88x
Streaming, 512 chars/update | 930.9ms | 1373.9ms | 1.48x | 2652.3ms | 2.85x
Static suite, one new document | 425.6ms | 177.9ms | 0.42x | 429.0ms | 1.01x

## Streaming CPU (median)

Fixture | chars | chunk | Renderer | Task CPU | Script CPU | Profiler | frame p95 | >25ms frames | long tasks | final render
--- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---:
Prose + CJK | 11311 | 128 | Michi current | 250.6ms | 38.9ms | 94.6ms | 8.9ms | 0 | 0 | 19.9ms
Prose + CJK | 11311 | 128 | Streamdown core | 334.1ms | 121.6ms | 226.7ms | 8.5ms | 0 | 0 | 0.9ms
Prose + CJK | 11311 | 128 | Streamdown featured | 544.9ms | 146.4ms | 267.6ms | 8.9ms | 0 | 0 | 23.5ms
GFM structure | 6001 | 128 | Streamdown core | 208.7ms | 91.4ms | 139.4ms | 8.6ms | 0 | 0 | 0.7ms
GFM structure | 6001 | 128 | Streamdown featured | 327.8ms | 108.7ms | 166.5ms | 9.6ms | 0 | 0 | 20.8ms
GFM structure | 6001 | 128 | Michi current | 153.2ms | 28.6ms | 68.0ms | 9.5ms | 1 | 0 | 19.8ms
Code-heavy | 22542 | 128 | Streamdown featured | 4576.7ms | 366.8ms | 3272.1ms | 50.3ms | 74 | 0 | 13.3ms
Code-heavy | 22542 | 128 | Michi current | 691.9ms | 113.1ms | 197.5ms | 9.5ms | 0 | 0 | 19.5ms
Code-heavy | 22542 | 128 | Streamdown core | 3289.6ms | 193.6ms | 3144.4ms | 42.7ms | 54 | 0 | 0.8ms
Math + raw HTML | 5848 | 128 | Michi current | 349.5ms | 101.1ms | 133.0ms | 8.7ms | 1 | 0 | 13.0ms
Math + raw HTML | 5848 | 128 | Streamdown core | 144.8ms | 68.1ms | 95.0ms | 8.5ms | 0 | 0 | 0.8ms
Math + raw HTML | 5848 | 128 | Streamdown featured | 462.2ms | 137.1ms | 193.4ms | 10.0ms | 0 | 0 | 38.2ms
Long footnotes | 11120 | 128 | Streamdown core | 765.2ms | 562.4ms | 345.5ms | 16.7ms | 0 | 0 | 1.0ms
Long footnotes | 11120 | 128 | Streamdown featured | 1146.6ms | 833.7ms | 986.4ms | 25.0ms | 4 | 0 | 14.5ms
Long footnotes | 11120 | 128 | Michi current | 375.8ms | 42.2ms | 105.2ms | 9.6ms | 0 | 0 | 22.5ms
Prose + CJK | 11311 | 512 | Streamdown core | 117.2ms | 54.1ms | 89.6ms | 8.4ms | 0 | 0 | 0.8ms
Prose + CJK | 11311 | 512 | Streamdown featured | 314.3ms | 82.4ms | 141.9ms | 16.7ms | 0 | 0 | 24.5ms
Prose + CJK | 11311 | 512 | Michi current | 89.8ms | 0.3ms | 38.3ms | 9.3ms | 0 | 0 | 22.7ms
GFM structure | 6001 | 512 | Streamdown featured | 197.8ms | 63.2ms | 102.8ms | 16.7ms | 0 | 0 | 22.6ms
GFM structure | 6001 | 512 | Michi current | 67.6ms | 0.2ms | 32.3ms | 8.4ms | 0 | 0 | 23.0ms
GFM structure | 6001 | 512 | Streamdown core | 75.7ms | 40.5ms | 56.1ms | 8.5ms | 0 | 0 | 0.7ms
Code-heavy | 22542 | 512 | Michi current | 430.1ms | 59.6ms | 100.8ms | 9.4ms | 0 | 0 | 12.5ms
Code-heavy | 22542 | 512 | Streamdown core | 885.2ms | 63.6ms | 836.7ms | 41.8ms | 13 | 0 | 0.6ms
Code-heavy | 22542 | 512 | Streamdown featured | 1429.0ms | 136.7ms | 933.8ms | 58.3ms | 23 | 0 | 13.8ms
Math + raw HTML | 5848 | 512 | Streamdown core | 52.2ms | 26.9ms | 37.3ms | 8.4ms | 0 | 0 | 0.6ms
Math + raw HTML | 5848 | 512 | Streamdown featured | 273.3ms | 90.0ms | 144.4ms | 25.0ms | 0 | 0 | 38.2ms
Math + raw HTML | 5848 | 512 | Michi current | 182.0ms | 50.9ms | 77.0ms | 9.1ms | 0 | 0 | 13.7ms
Long footnotes | 11120 | 512 | Streamdown featured | 437.9ms | 260.2ms | 320.7ms | 25.9ms | 3 | 0 | 15.4ms
Long footnotes | 11120 | 512 | Michi current | 161.5ms | 0.5ms | 50.8ms | 16.6ms | 0 | 0 | 24.5ms
Long footnotes | 11120 | 512 | Streamdown core | 243.6ms | 168.2ms | 110.2ms | 16.7ms | 0 | 0 | 1.3ms

## Michi semantic snapshot lag during streaming

Fixture | chunk | semantic snapshots | average lag | max lag
--- | ---: | ---: | ---: | ---:
Prose + CJK | 128 | 3 | 2364.9 chars | 5120 chars
GFM structure | 128 | 2 | 2290.1 chars | 5120 chars
Code-heavy | 128 | 5 | 2454.5 chars | 5248 chars
Math + raw HTML | 128 | 2 | 2322.6 chars | 5120 chars
Long footnotes | 128 | 3 | 2495.1 chars | 5248 chars
Prose + CJK | 512 | 1 | 5611.8 chars | 10799 chars
GFM structure | 512 | 1 | 2804.1 chars | 5489 chars
Code-heavy | 512 | 2 | 9034.3 chars | 19968 chars
Math + raw HTML | 512 | 1 | 2791.3 chars | 5336 chars
Long footnotes | 512 | 1 | 5369.5 chars | 10608 chars

## Static full-document render (one new document, median)

Fixture | chars | Renderer | Task CPU | Script CPU | Profiler | render call p95 | DOM nodes
--- | ---: | --- | ---: | ---: | ---: | ---: | ---:
Prose + CJK | 11311 | Michi current | 38.8ms | 0.1ms | 24.8ms | 25.4ms | 197
Prose + CJK | 11311 | Streamdown core | 33.9ms | 0.1ms | 26.3ms | 26.4ms | 225
Prose + CJK | 11311 | Streamdown featured | 40.3ms | 0.1ms | 32.1ms | 32.4ms | 225
GFM structure | 6001 | Streamdown core | 44.0ms | 0.1ms | 35.2ms | 35.5ms | 540
GFM structure | 6001 | Streamdown featured | 45.4ms | 0.1ms | 36.6ms | 37.1ms | 540
GFM structure | 6001 | Michi current | 41.0ms | 0.1ms | 32.1ms | 32.4ms | 510
Code-heavy | 22542 | Streamdown featured | 226.1ms | 38.7ms | 56.0ms | 23.3ms | 6673
Code-heavy | 22542 | Michi current | 208.0ms | 35.4ms | 53.3ms | 20.5ms | 6753
Code-heavy | 22542 | Streamdown core | 31.5ms | 0.1ms | 22.5ms | 22.7ms | 881
Math + raw HTML | 5848 | Michi current | 92.3ms | 47.0ms | 63.4ms | 18.8ms | 3453
Math + raw HTML | 5848 | Streamdown core | 20.6ms | 0.1ms | 15.1ms | 15.4ms | 145
Math + raw HTML | 5848 | Streamdown featured | 71.4ms | 0.0ms | 46.9ms | 47.9ms | 3723
Long footnotes | 11120 | Streamdown core | 47.9ms | 0.1ms | 36.0ms | 36.6ms | 481
Long footnotes | 11120 | Streamdown featured | 45.7ms | 0.1ms | 36.1ms | 36.4ms | 481
Long footnotes | 11120 | Michi current | 45.5ms | 0.1ms | 34.5ms | 34.8ms | 481

## Instrumentation notes

- Michi current uses the repository components unchanged: 3Hz Markdown reinterpretation, incremental unstable-tail lexing, one-character reveal, then a full non-streaming render at completion.
- Streamdown core disables optional code/math/CJK plugins and animation.
- Streamdown featured enables code, math (single-dollar inline math), CJK, and its recommended animation. Controls and link-safety UI are disabled for both Streamdown modes.
- Task/Script/Layout metrics come from Chrome DevTools Protocol. React Profiler time and frame intervals come from the page harness. Module loading and the first async syntax-highlighter initialization are warmed before measurement.
- Michi semantic lag counts source characters waiting for the next 3Hz Markdown reinterpretation. Those characters are still visible immediately as the plain-text pending tail; only their Markdown semantics lag.
- Code fixtures use equal-length unique source markers for every measured document so syntax-highlighting result caches cannot make later samples artificially cheap.
