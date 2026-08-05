# Michi vs Streamdown local benchmark

Generated: 2026-08-05T09:31:16.663Z
Browser: 148.0.7778.96
Machine: darwin / arm64
Streamdown: 2.5.0; repeats: 3; paced updates: one per requestAnimationFrame

## Suite summary (sum of fixture medians)

Suite | Michi task CPU | Streamdown core | core / Michi | Streamdown featured | featured / Michi
--- | ---: | ---: | ---: | ---: | ---:
Streaming, 128 chars/update | 1883.0ms | 4805.0ms | 2.55x | 7408.1ms | 3.93x
Streaming, 512 chars/update | 992.7ms | 1461.2ms | 1.47x | 2836.4ms | 2.86x
Static suite, one new document | 431.8ms | 158.5ms | 0.37x | 411.8ms | 0.95x

## Streaming CPU (median)

Fixture | chars | chunk | Renderer | Task CPU | Script CPU | Profiler | frame p95 | >25ms frames | long tasks | final render
--- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---:
Prose + CJK | 11311 | 128 | Michi current | 259.7ms | 39.0ms | 98.5ms | 9.1ms | 0 | 0 | 19.3ms
Prose + CJK | 11311 | 128 | Streamdown core | 331.8ms | 120.7ms | 229.8ms | 8.9ms | 0 | 0 | 0.9ms
Prose + CJK | 11311 | 128 | Streamdown featured | 602.0ms | 163.8ms | 287.1ms | 8.9ms | 0 | 0 | 25.5ms
GFM structure | 6001 | 128 | Streamdown core | 204.5ms | 94.1ms | 138.8ms | 9.1ms | 0 | 0 | 0.7ms
GFM structure | 6001 | 128 | Streamdown featured | 359.3ms | 115.9ms | 178.9ms | 9.0ms | 0 | 0 | 22.1ms
GFM structure | 6001 | 128 | Michi current | 170.8ms | 30.0ms | 70.5ms | 9.1ms | 0 | 0 | 19.8ms
Code-heavy | 22542 | 128 | Streamdown featured | 4752.9ms | 383.7ms | 3394.2ms | 58.3ms | 78 | 1 | 14.4ms
Code-heavy | 22542 | 128 | Michi current | 700.1ms | 106.7ms | 192.5ms | 9.2ms | 0 | 0 | 18.0ms
Code-heavy | 22542 | 128 | Streamdown core | 3348.4ms | 198.5ms | 3214.8ms | 49.9ms | 52 | 0 | 0.8ms
Math + raw HTML | 5848 | 128 | Michi current | 368.4ms | 107.6ms | 139.0ms | 16.7ms | 1 | 0 | 13.9ms
Math + raw HTML | 5848 | 128 | Streamdown core | 134.7ms | 62.8ms | 86.9ms | 8.7ms | 0 | 0 | 0.7ms
Math + raw HTML | 5848 | 128 | Streamdown featured | 502.5ms | 163.2ms | 214.4ms | 16.3ms | 0 | 0 | 37.7ms
Long footnotes | 11120 | 128 | Streamdown core | 785.6ms | 576.1ms | 362.3ms | 16.8ms | 0 | 0 | 1.0ms
Long footnotes | 11120 | 128 | Streamdown featured | 1191.4ms | 865.4ms | 1023.9ms | 25.0ms | 4 | 0 | 13.9ms
Long footnotes | 11120 | 128 | Michi current | 384.0ms | 40.0ms | 101.3ms | 9.2ms | 0 | 0 | 21.5ms
Prose + CJK | 11311 | 512 | Streamdown core | 123.7ms | 56.4ms | 90.7ms | 8.4ms | 0 | 0 | 0.9ms
Prose + CJK | 11311 | 512 | Streamdown featured | 362.3ms | 94.2ms | 153.1ms | 16.7ms | 0 | 0 | 24.8ms
Prose + CJK | 11311 | 512 | Michi current | 93.4ms | 0.5ms | 37.7ms | 8.9ms | 0 | 0 | 21.3ms
GFM structure | 6001 | 512 | Streamdown featured | 220.2ms | 73.1ms | 113.8ms | 17.3ms | 0 | 0 | 24.0ms
GFM structure | 6001 | 512 | Michi current | 66.6ms | 0.3ms | 32.8ms | 8.8ms | 0 | 0 | 22.6ms
GFM structure | 6001 | 512 | Streamdown core | 77.8ms | 41.3ms | 57.4ms | 8.5ms | 0 | 0 | 0.7ms
Code-heavy | 22542 | 512 | Michi current | 466.8ms | 61.8ms | 104.3ms | 16.7ms | 0 | 0 | 13.4ms
Code-heavy | 22542 | 512 | Streamdown core | 952.3ms | 69.5ms | 896.1ms | 50.0ms | 14 | 1 | 0.8ms
Code-heavy | 22542 | 512 | Streamdown featured | 1496.6ms | 145.3ms | 974.0ms | 58.4ms | 24 | 1 | 10.5ms
Math + raw HTML | 5848 | 512 | Streamdown core | 57.0ms | 28.9ms | 39.0ms | 8.8ms | 0 | 0 | 0.6ms
Math + raw HTML | 5848 | 512 | Streamdown featured | 295.0ms | 99.7ms | 154.6ms | 25.1ms | 1 | 0 | 40.5ms
Math + raw HTML | 5848 | 512 | Michi current | 193.5ms | 53.3ms | 87.0ms | 9.0ms | 0 | 0 | 13.9ms
Long footnotes | 11120 | 512 | Streamdown featured | 462.3ms | 274.1ms | 329.9ms | 25.1ms | 2 | 0 | 15.8ms
Long footnotes | 11120 | 512 | Michi current | 172.4ms | 1.0ms | 45.7ms | 16.7ms | 0 | 0 | 24.4ms
Long footnotes | 11120 | 512 | Streamdown core | 250.2ms | 175.9ms | 114.3ms | 16.7ms | 0 | 0 | 1.1ms

## Michi semantic snapshot lag during streaming

Fixture | chunk | semantic snapshots | average lag | max lag
--- | ---: | ---: | ---: | ---:
Prose + CJK | 128 | 3 | 2364.9 chars | 5120 chars
GFM structure | 128 | 2 | 2290.1 chars | 5120 chars
Code-heavy | 128 | 5 | 2437.1 chars | 5120 chars
Math + raw HTML | 128 | 2 | 2228.0 chars | 4992 chars
Long footnotes | 128 | 3 | 2445.1 chars | 5248 chars
Prose + CJK | 512 | 1 | 5611.8 chars | 10799 chars
GFM structure | 512 | 1 | 2804.1 chars | 5489 chars
Code-heavy | 512 | 2 | 8306.1 chars | 18944 chars
Math + raw HTML | 512 | 1 | 2791.3 chars | 5336 chars
Long footnotes | 512 | 1 | 5369.5 chars | 10608 chars

## Static full-document render (one new document, median)

Fixture | chars | Renderer | Task CPU | Script CPU | Profiler | render call p95 | DOM nodes
--- | ---: | --- | ---: | ---: | ---: | ---: | ---:
Prose + CJK | 11311 | Michi current | 33.3ms | 0.1ms | 25.4ms | 25.6ms | 197
Prose + CJK | 11311 | Streamdown core | 32.2ms | 0.1ms | 24.7ms | 25.0ms | 225
Prose + CJK | 11311 | Streamdown featured | 32.8ms | 0.1ms | 26.0ms | 26.4ms | 225
GFM structure | 6001 | Streamdown core | 37.4ms | 0.0ms | 31.7ms | 31.8ms | 540
GFM structure | 6001 | Streamdown featured | 36.5ms | 0.1ms | 29.6ms | 30.0ms | 540
GFM structure | 6001 | Michi current | 34.6ms | 0.1ms | 27.3ms | 27.5ms | 510
Code-heavy | 22542 | Streamdown featured | 231.1ms | 47.2ms | 56.9ms | 19.3ms | 6673
Code-heavy | 22542 | Michi current | 219.5ms | 38.1ms | 52.5ms | 18.0ms | 6753
Code-heavy | 22542 | Streamdown core | 26.8ms | 0.1ms | 18.0ms | 18.3ms | 881
Math + raw HTML | 5848 | Michi current | 105.6ms | 54.6ms | 66.4ms | 16.3ms | 3453
Math + raw HTML | 5848 | Streamdown core | 17.7ms | 0.1ms | 13.3ms | 13.5ms | 145
Math + raw HTML | 5848 | Streamdown featured | 70.3ms | 0.1ms | 46.5ms | 47.0ms | 3723
Long footnotes | 11120 | Streamdown core | 44.4ms | 0.1ms | 31.2ms | 31.8ms | 481
Long footnotes | 11120 | Streamdown featured | 41.2ms | 0.0ms | 32.5ms | 33.0ms | 481
Long footnotes | 11120 | Michi current | 38.9ms | 0.1ms | 29.4ms | 29.5ms | 481

## Instrumentation notes

- Michi current uses the repository components unchanged: 3Hz Markdown reinterpretation, incremental unstable-tail lexing, one-character reveal, then a full non-streaming render at completion.
- Streamdown core disables optional code/math/CJK plugins and animation.
- Streamdown featured enables code, math (single-dollar inline math), CJK, and its recommended animation. Controls and link-safety UI are disabled for both Streamdown modes.
- Task/Script/Layout metrics come from Chrome DevTools Protocol. React Profiler time and frame intervals come from the page harness. Module loading and the first async syntax-highlighter initialization are warmed before measurement.
- Michi semantic lag counts source characters waiting for the next 3Hz Markdown reinterpretation. Those characters are still visible immediately as the plain-text pending tail; only their Markdown semantics lag.
- Code fixtures use equal-length unique source markers for every measured document so syntax-highlighting result caches cannot make later samples artificially cheap.
