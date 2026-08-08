# Michi vs Streamdown local benchmark

Generated: 2026-08-05T11:07:42.671Z
Browser: 148.0.7778.96
Machine: darwin / arm64
Streamdown: 2.5.0; repeats: 3; paced updates: one per requestAnimationFrame

## Suite summary (sum of fixture medians)

Suite | Michi task CPU | Streamdown core | core / Michi | Streamdown featured | featured / Michi
--- | ---: | ---: | ---: | ---: | ---:
Streaming, 128 chars/update | 1407.0ms | 5019.8ms | 3.57x | 7914.9ms | 5.63x
Streaming, 512 chars/update | 745.1ms | 1525.5ms | 2.05x | 3078.9ms | 4.13x
Static suite, one new document | 407.8ms | 155.3ms | 0.38x | 417.5ms | 1.02x

## Streaming CPU (median)

Fixture | chars | chunk | Renderer | Task CPU | Script CPU | Profiler | frame p95 | >25ms frames | long tasks | final render
--- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---:
Prose + CJK | 11311 | 128 | Michi current | 242.7ms | 39.2ms | 94.3ms | 9.2ms | 0 | 0 | 18.7ms
Prose + CJK | 11311 | 128 | Streamdown core | 335.3ms | 121.9ms | 233.2ms | 9.2ms | 0 | 0 | 1.0ms
Prose + CJK | 11311 | 128 | Streamdown featured | 634.2ms | 167.1ms | 292.3ms | 9.3ms | 0 | 0 | 25.0ms
GFM structure | 6001 | 128 | Streamdown core | 197.9ms | 90.6ms | 137.4ms | 9.2ms | 0 | 0 | 1.0ms
GFM structure | 6001 | 128 | Streamdown featured | 396.2ms | 126.7ms | 191.8ms | 9.1ms | 0 | 0 | 24.5ms
GFM structure | 6001 | 128 | Michi current | 159.4ms | 32.3ms | 77.4ms | 9.9ms | 1 | 0 | 22.8ms
Code-heavy | 22542 | 128 | Streamdown featured | 5012.5ms | 428.9ms | 3552.8ms | 58.3ms | 85 | 4 | 15.1ms
Code-heavy | 22542 | 128 | Michi current | 507.2ms | 104.7ms | 149.7ms | 9.4ms | 0 | 0 | 15.0ms
Code-heavy | 22542 | 128 | Streamdown core | 3503.4ms | 220.8ms | 3336.5ms | 49.9ms | 59 | 2 | 0.9ms
Math + raw HTML | 5848 | 128 | Michi current | 262.1ms | 136.9ms | 158.2ms | 9.9ms | 1 | 1 | 14.9ms
Math + raw HTML | 5848 | 128 | Streamdown core | 141.6ms | 66.9ms | 89.4ms | 9.5ms | 0 | 0 | 0.7ms
Math + raw HTML | 5848 | 128 | Streamdown featured | 552.0ms | 165.1ms | 232.5ms | 17.1ms | 0 | 1 | 51.6ms
Long footnotes | 11120 | 128 | Streamdown core | 841.6ms | 612.1ms | 353.4ms | 18.0ms | 2 | 0 | 1.4ms
Long footnotes | 11120 | 128 | Streamdown featured | 1320.0ms | 931.9ms | 1100.6ms | 25.8ms | 8 | 0 | 15.8ms
Long footnotes | 11120 | 128 | Michi current | 235.6ms | 42.8ms | 87.3ms | 9.8ms | 1 | 0 | 24.2ms
Prose + CJK | 11311 | 512 | Streamdown core | 135.7ms | 65.0ms | 101.1ms | 9.3ms | 0 | 0 | 1.0ms
Prose + CJK | 11311 | 512 | Streamdown featured | 430.8ms | 109.3ms | 174.2ms | 17.3ms | 0 | 0 | 32.1ms
Prose + CJK | 11311 | 512 | Michi current | 110.9ms | 0.7ms | 44.5ms | 9.4ms | 0 | 0 | 24.8ms
GFM structure | 6001 | 512 | Streamdown featured | 253.5ms | 76.9ms | 122.9ms | 24.0ms | 0 | 0 | 27.2ms
GFM structure | 6001 | 512 | Michi current | 75.5ms | 0.2ms | 36.2ms | 9.9ms | 0 | 0 | 25.1ms
GFM structure | 6001 | 512 | Streamdown core | 93.9ms | 54.9ms | 63.7ms | 9.3ms | 0 | 0 | 0.9ms
Code-heavy | 22542 | 512 | Michi current | 347.2ms | 67.5ms | 93.5ms | 9.5ms | 0 | 0 | 14.3ms
Code-heavy | 22542 | 512 | Streamdown core | 977.9ms | 76.2ms | 915.3ms | 50.6ms | 17 | 2 | 0.9ms
Code-heavy | 22542 | 512 | Streamdown featured | 1547.4ms | 159.1ms | 1002.6ms | 59.3ms | 27 | 2 | 14.8ms
Math + raw HTML | 5848 | 512 | Streamdown core | 57.9ms | 31.4ms | 41.9ms | 9.0ms | 0 | 0 | 0.7ms
Math + raw HTML | 5848 | 512 | Streamdown featured | 343.9ms | 118.8ms | 184.4ms | 33.4ms | 2 | 1 | 56.6ms
Math + raw HTML | 5848 | 512 | Michi current | 124.7ms | 62.4ms | 82.1ms | 9.3ms | 0 | 1 | 14.6ms
Long footnotes | 11120 | 512 | Streamdown featured | 503.4ms | 285.5ms | 345.1ms | 32.1ms | 3 | 0 | 18.0ms
Long footnotes | 11120 | 512 | Michi current | 86.8ms | 0.7ms | 35.1ms | 9.2ms | 0 | 0 | 26.1ms
Long footnotes | 11120 | 512 | Streamdown core | 260.1ms | 176.4ms | 108.3ms | 16.9ms | 0 | 0 | 1.5ms

## Michi semantic snapshot lag during streaming

Fixture | chunk | semantic snapshots | average lag | max lag
--- | ---: | ---: | ---: | ---:
Prose + CJK | 128 | 3 | 2364.9 chars | 5120 chars
GFM structure | 128 | 2 | 2290.1 chars | 5120 chars
Code-heavy | 128 | 5 | 2453.1 chars | 5120 chars
Math + raw HTML | 128 | 2 | 2322.6 chars | 5120 chars
Long footnotes | 128 | 3 | 2443.6 chars | 5120 chars
Prose + CJK | 512 | 1 | 5611.8 chars | 10799 chars
GFM structure | 512 | 1 | 2804.1 chars | 5489 chars
Code-heavy | 512 | 2 | 9432.5 chars | 20480 chars
Math + raw HTML | 512 | 1 | 2791.3 chars | 5336 chars
Long footnotes | 512 | 1 | 5369.5 chars | 10608 chars

## Static full-document render (one new document, median)

Fixture | chars | Renderer | Task CPU | Script CPU | Profiler | render call p95 | DOM nodes
--- | ---: | --- | ---: | ---: | ---: | ---: | ---:
Prose + CJK | 11311 | Michi current | 33.5ms | 0.1ms | 26.8ms | 26.8ms | 197
Prose + CJK | 11311 | Streamdown core | 33.1ms | 0.1ms | 25.9ms | 26.2ms | 225
Prose + CJK | 11311 | Streamdown featured | 33.7ms | 0.1ms | 27.2ms | 27.3ms | 225
GFM structure | 6001 | Streamdown core | 37.5ms | 0.1ms | 30.8ms | 31.5ms | 540
GFM structure | 6001 | Streamdown featured | 36.8ms | 0.1ms | 30.7ms | 31.0ms | 540
GFM structure | 6001 | Michi current | 32.1ms | 0.0ms | 25.5ms | 25.9ms | 510
Code-heavy | 22542 | Streamdown featured | 235.5ms | 41.1ms | 54.1ms | 18.8ms | 6673
Code-heavy | 22542 | Michi current | 210.2ms | 37.4ms | 51.7ms | 18.1ms | 6753
Code-heavy | 22542 | Streamdown core | 25.3ms | 0.0ms | 17.2ms | 17.6ms | 881
Math + raw HTML | 5848 | Michi current | 93.5ms | 52.0ms | 65.4ms | 15.7ms | 3453
Math + raw HTML | 5848 | Streamdown core | 18.3ms | 0.1ms | 14.5ms | 14.7ms | 145
Math + raw HTML | 5848 | Streamdown featured | 71.5ms | 0.1ms | 47.6ms | 48.4ms | 3723
Long footnotes | 11120 | Streamdown core | 41.1ms | 0.0ms | 31.5ms | 31.8ms | 481
Long footnotes | 11120 | Streamdown featured | 40.0ms | 0.0ms | 31.7ms | 32.0ms | 481
Long footnotes | 11120 | Michi current | 38.6ms | 0.1ms | 30.1ms | 30.4ms | 481

## Instrumentation notes

- Michi current uses the repository components unchanged: 3Hz Markdown reinterpretation, incremental unstable-tail lexing, one-character reveal, then a full non-streaming render at completion.
- Streamdown core disables optional code/math/CJK plugins and animation.
- Streamdown featured enables code, math (single-dollar inline math), CJK, and its recommended animation. Controls and link-safety UI are disabled for both Streamdown modes.
- Task/Script/Layout metrics come from Chrome DevTools Protocol. React Profiler time and frame intervals come from the page harness. Module loading and the first async syntax-highlighter initialization are warmed before measurement.
- Michi semantic lag counts source characters waiting for the next 3Hz Markdown reinterpretation. Those characters are still visible immediately as the plain-text pending tail; only their Markdown semantics lag.
- Code fixtures use equal-length unique source markers for every measured document so syntax-highlighting result caches cannot make later samples artificially cheap.
