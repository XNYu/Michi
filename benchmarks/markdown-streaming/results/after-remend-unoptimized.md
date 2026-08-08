# Michi vs Streamdown local benchmark

Generated: 2026-08-05T09:24:27.646Z
Browser: 148.0.7778.96
Machine: darwin / arm64
Streamdown: 2.5.0; repeats: 3; paced updates: one per requestAnimationFrame

## Suite summary (sum of fixture medians)

Suite | Michi task CPU | Streamdown core | core / Michi | Streamdown featured | featured / Michi
--- | ---: | ---: | ---: | ---: | ---:
Streaming, 128 chars/update | 2049.0ms | 4752.8ms | 2.32x | 7109.6ms | 3.47x
Streaming, 512 chars/update | 1106.1ms | 1384.1ms | 1.25x | 2699.5ms | 2.44x
Static suite, one new document | 425.2ms | 193.1ms | 0.45x | 434.9ms | 1.02x

## Streaming CPU (median)

Fixture | chars | chunk | Renderer | Task CPU | Script CPU | Profiler | frame p95 | >25ms frames | long tasks | final render
--- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---:
Prose + CJK | 11311 | 128 | Michi current | 274.0ms | 39.2ms | 110.2ms | 9.3ms | 0 | 0 | 18.6ms
Prose + CJK | 11311 | 128 | Streamdown core | 338.9ms | 125.4ms | 234.2ms | 9.1ms | 0 | 0 | 0.9ms
Prose + CJK | 11311 | 128 | Streamdown featured | 541.1ms | 145.8ms | 265.9ms | 8.8ms | 0 | 0 | 24.0ms
GFM structure | 6001 | 128 | Streamdown core | 196.2ms | 90.0ms | 134.5ms | 8.6ms | 0 | 0 | 0.8ms
GFM structure | 6001 | 128 | Streamdown featured | 319.9ms | 100.7ms | 159.3ms | 9.4ms | 0 | 0 | 21.2ms
GFM structure | 6001 | 128 | Michi current | 156.7ms | 29.0ms | 72.4ms | 9.9ms | 0 | 0 | 19.0ms
Code-heavy | 22542 | 128 | Streamdown featured | 4638.0ms | 371.4ms | 3323.8ms | 58.2ms | 73 | 0 | 10.0ms
Code-heavy | 22542 | 128 | Michi current | 895.2ms | 105.1ms | 241.3ms | 9.8ms | 0 | 0 | 21.0ms
Code-heavy | 22542 | 128 | Streamdown core | 3310.2ms | 197.2ms | 3157.9ms | 50.0ms | 50 | 1 | 0.8ms
Math + raw HTML | 5848 | 128 | Michi current | 359.7ms | 100.9ms | 137.3ms | 9.0ms | 1 | 0 | 12.8ms
Math + raw HTML | 5848 | 128 | Streamdown core | 146.8ms | 69.0ms | 93.3ms | 8.5ms | 0 | 0 | 0.8ms
Math + raw HTML | 5848 | 128 | Streamdown featured | 470.8ms | 145.3ms | 203.6ms | 9.4ms | 0 | 0 | 37.9ms
Long footnotes | 11120 | 128 | Streamdown core | 760.8ms | 560.6ms | 359.1ms | 16.7ms | 0 | 0 | 1.0ms
Long footnotes | 11120 | 128 | Streamdown featured | 1139.9ms | 824.5ms | 984.1ms | 25.1ms | 5 | 0 | 15.4ms
Long footnotes | 11120 | 128 | Michi current | 363.4ms | 40.6ms | 110.2ms | 8.5ms | 0 | 0 | 21.9ms
Prose + CJK | 11311 | 512 | Streamdown core | 125.5ms | 56.7ms | 90.6ms | 10.2ms | 0 | 0 | 0.9ms
Prose + CJK | 11311 | 512 | Streamdown featured | 366.0ms | 93.5ms | 150.4ms | 17.3ms | 0 | 0 | 25.7ms
Prose + CJK | 11311 | 512 | Michi current | 101.7ms | 0.6ms | 45.4ms | 9.9ms | 0 | 0 | 21.3ms
GFM structure | 6001 | 512 | Streamdown featured | 200.8ms | 64.6ms | 99.4ms | 17.4ms | 0 | 0 | 23.3ms
GFM structure | 6001 | 512 | Michi current | 66.5ms | 0.3ms | 33.2ms | 10.0ms | 0 | 0 | 21.8ms
GFM structure | 6001 | 512 | Streamdown core | 75.4ms | 40.7ms | 56.7ms | 8.6ms | 0 | 0 | 0.7ms
Code-heavy | 22542 | 512 | Michi current | 592.3ms | 61.2ms | 139.8ms | 16.7ms | 0 | 0 | 15.6ms
Code-heavy | 22542 | 512 | Streamdown core | 886.6ms | 62.7ms | 834.7ms | 41.7ms | 12 | 0 | 0.7ms
Code-heavy | 22542 | 512 | Streamdown featured | 1427.0ms | 137.9ms | 923.4ms | 58.3ms | 23 | 1 | 10.1ms
Math + raw HTML | 5848 | 512 | Streamdown core | 54.4ms | 27.6ms | 37.7ms | 8.5ms | 0 | 0 | 0.7ms
Math + raw HTML | 5848 | 512 | Streamdown featured | 269.5ms | 85.9ms | 140.9ms | 25.0ms | 0 | 0 | 39.2ms
Math + raw HTML | 5848 | 512 | Michi current | 182.6ms | 50.6ms | 77.3ms | 16.6ms | 0 | 0 | 13.4ms
Long footnotes | 11120 | 512 | Streamdown featured | 436.3ms | 258.8ms | 319.6ms | 25.6ms | 2 | 0 | 16.1ms
Long footnotes | 11120 | 512 | Michi current | 163.0ms | 0.6ms | 49.4ms | 15.0ms | 0 | 0 | 24.2ms
Long footnotes | 11120 | 512 | Streamdown core | 242.3ms | 171.7ms | 109.1ms | 16.7ms | 0 | 0 | 1.4ms

## Michi semantic snapshot lag during streaming

Fixture | chunk | semantic snapshots | average lag | max lag
--- | ---: | ---: | ---: | ---:
Prose + CJK | 128 | 3 | 2409.5 chars | 5120 chars
GFM structure | 128 | 2 | 2290.1 chars | 5120 chars
Code-heavy | 128 | 5 | 2437.9 chars | 5120 chars
Math + raw HTML | 128 | 2 | 2322.6 chars | 5120 chars
Long footnotes | 128 | 3 | 2495.1 chars | 5248 chars
Prose + CJK | 512 | 1 | 5611.8 chars | 10799 chars
GFM structure | 512 | 1 | 2804.1 chars | 5489 chars
Code-heavy | 512 | 2 | 6303.6 chars | 14848 chars
Math + raw HTML | 512 | 1 | 2791.3 chars | 5336 chars
Long footnotes | 512 | 1 | 5369.5 chars | 10608 chars

## Static full-document render (one new document, median)

Fixture | chars | Renderer | Task CPU | Script CPU | Profiler | render call p95 | DOM nodes
--- | ---: | --- | ---: | ---: | ---: | ---: | ---:
Prose + CJK | 11311 | Michi current | 41.7ms | 0.1ms | 31.4ms | 31.9ms | 197
Prose + CJK | 11311 | Streamdown core | 42.5ms | 0.1ms | 32.4ms | 32.8ms | 225
Prose + CJK | 11311 | Streamdown featured | 41.8ms | 0.1ms | 32.4ms | 32.8ms | 225
GFM structure | 6001 | Streamdown core | 44.1ms | 0.1ms | 36.8ms | 37.2ms | 540
GFM structure | 6001 | Streamdown featured | 45.5ms | 0.1ms | 35.7ms | 36.0ms | 540
GFM structure | 6001 | Michi current | 40.2ms | 0.1ms | 31.5ms | 32.0ms | 510
Code-heavy | 22542 | Streamdown featured | 220.8ms | 39.0ms | 56.4ms | 23.2ms | 6673
Code-heavy | 22542 | Michi current | 201.4ms | 33.2ms | 51.1ms | 20.3ms | 6753
Code-heavy | 22542 | Streamdown core | 35.1ms | 0.1ms | 23.3ms | 23.9ms | 881
Math + raw HTML | 5848 | Michi current | 96.2ms | 48.2ms | 64.2ms | 18.4ms | 3453
Math + raw HTML | 5848 | Streamdown core | 21.5ms | 0.1ms | 15.8ms | 15.9ms | 145
Math + raw HTML | 5848 | Streamdown featured | 77.9ms | 0.1ms | 52.8ms | 53.5ms | 3723
Long footnotes | 11120 | Streamdown core | 49.9ms | 0.1ms | 37.7ms | 38.1ms | 481
Long footnotes | 11120 | Streamdown featured | 48.9ms | 0.1ms | 37.2ms | 37.9ms | 481
Long footnotes | 11120 | Michi current | 45.7ms | 0.1ms | 34.7ms | 35.1ms | 481

## Instrumentation notes

- Michi current uses the repository components unchanged: 3Hz Markdown reinterpretation, incremental unstable-tail lexing, one-character reveal, then a full non-streaming render at completion.
- Streamdown core disables optional code/math/CJK plugins and animation.
- Streamdown featured enables code, math (single-dollar inline math), CJK, and its recommended animation. Controls and link-safety UI are disabled for both Streamdown modes.
- Task/Script/Layout metrics come from Chrome DevTools Protocol. React Profiler time and frame intervals come from the page harness. Module loading and the first async syntax-highlighter initialization are warmed before measurement.
- Michi semantic lag counts source characters waiting for the next 3Hz Markdown reinterpretation. Those characters are still visible immediately as the plain-text pending tail; only their Markdown semantics lag.
- Code fixtures use equal-length unique source markers for every measured document so syntax-highlighting result caches cannot make later samples artificially cheap.
