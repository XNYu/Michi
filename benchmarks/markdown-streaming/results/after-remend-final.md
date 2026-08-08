# Michi vs Streamdown local benchmark

Generated: 2026-08-05T09:33:47.413Z
Browser: 148.0.7778.96
Machine: darwin / arm64
Streamdown: 2.5.0; repeats: 3; paced updates: one per requestAnimationFrame

## Suite summary (sum of fixture medians)

Suite | Michi task CPU | Streamdown core | core / Michi | Streamdown featured | featured / Michi
--- | ---: | ---: | ---: | ---: | ---:
Streaming, 128 chars/update | 1401.2ms | 4820.7ms | 3.44x | 7428.2ms | 5.30x
Streaming, 512 chars/update | 688.3ms | 1452.7ms | 2.11x | 2895.3ms | 4.21x
Static suite, one new document | 400.3ms | 169.1ms | 0.42x | 420.1ms | 1.05x

## Streaming CPU (median)

Fixture | chars | chunk | Renderer | Task CPU | Script CPU | Profiler | frame p95 | >25ms frames | long tasks | final render
--- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---:
Prose + CJK | 11311 | 128 | Michi current | 219.9ms | 37.7ms | 88.2ms | 9.2ms | 0 | 0 | 18.6ms
Prose + CJK | 11311 | 128 | Streamdown core | 310.9ms | 110.1ms | 218.3ms | 9.1ms | 0 | 0 | 1.0ms
Prose + CJK | 11311 | 128 | Streamdown featured | 592.3ms | 157.3ms | 287.7ms | 9.1ms | 0 | 0 | 28.3ms
GFM structure | 6001 | 128 | Streamdown core | 201.5ms | 91.7ms | 136.9ms | 8.6ms | 0 | 0 | 0.8ms
GFM structure | 6001 | 128 | Streamdown featured | 351.3ms | 109.3ms | 169.7ms | 9.0ms | 0 | 0 | 21.7ms
GFM structure | 6001 | 128 | Michi current | 154.4ms | 30.6ms | 69.7ms | 9.1ms | 0 | 0 | 21.4ms
Code-heavy | 22542 | 128 | Streamdown featured | 4761.5ms | 393.1ms | 3403.4ms | 58.3ms | 76 | 2 | 15.5ms
Code-heavy | 22542 | 128 | Michi current | 541.0ms | 115.8ms | 174.6ms | 9.0ms | 0 | 0 | 18.9ms
Code-heavy | 22542 | 128 | Streamdown core | 3367.0ms | 201.1ms | 3223.7ms | 50.0ms | 51 | 3 | 0.8ms
Math + raw HTML | 5848 | 128 | Michi current | 260.9ms | 130.8ms | 146.9ms | 9.3ms | 1 | 1 | 14.1ms
Math + raw HTML | 5848 | 128 | Streamdown core | 126.2ms | 60.8ms | 84.4ms | 9.1ms | 0 | 0 | 0.7ms
Math + raw HTML | 5848 | 128 | Streamdown featured | 455.6ms | 131.2ms | 189.0ms | 9.3ms | 0 | 0 | 41.7ms
Long footnotes | 11120 | 128 | Streamdown core | 815.0ms | 600.4ms | 358.1ms | 17.3ms | 1 | 0 | 1.2ms
Long footnotes | 11120 | 128 | Streamdown featured | 1267.5ms | 922.0ms | 1079.3ms | 25.3ms | 7 | 0 | 14.9ms
Long footnotes | 11120 | 128 | Michi current | 225.0ms | 40.1ms | 78.9ms | 9.3ms | 0 | 0 | 22.1ms
Prose + CJK | 11311 | 512 | Streamdown core | 128.9ms | 60.2ms | 96.1ms | 9.2ms | 0 | 0 | 1.0ms
Prose + CJK | 11311 | 512 | Streamdown featured | 375.7ms | 93.0ms | 149.3ms | 16.7ms | 0 | 0 | 26.5ms
Prose + CJK | 11311 | 512 | Michi current | 95.7ms | 0.6ms | 37.7ms | 9.0ms | 0 | 0 | 23.1ms
GFM structure | 6001 | 512 | Streamdown featured | 219.2ms | 69.4ms | 109.5ms | 16.8ms | 0 | 0 | 24.8ms
GFM structure | 6001 | 512 | Michi current | 68.6ms | 0.3ms | 32.8ms | 8.7ms | 0 | 0 | 23.3ms
GFM structure | 6001 | 512 | Streamdown core | 79.6ms | 44.6ms | 61.8ms | 9.2ms | 0 | 0 | 0.8ms
Code-heavy | 22542 | 512 | Michi current | 322.6ms | 59.6ms | 82.7ms | 9.2ms | 0 | 0 | 13.3ms
Code-heavy | 22542 | 512 | Streamdown core | 944.4ms | 70.1ms | 895.5ms | 50.0ms | 14 | 2 | 0.8ms
Code-heavy | 22542 | 512 | Streamdown featured | 1535.6ms | 148.7ms | 1002.8ms | 59.1ms | 28 | 2 | 13.8ms
Math + raw HTML | 5848 | 512 | Streamdown core | 54.1ms | 29.1ms | 39.0ms | 9.2ms | 0 | 0 | 0.7ms
Math + raw HTML | 5848 | 512 | Streamdown featured | 290.0ms | 95.1ms | 153.3ms | 25.5ms | 1 | 1 | 42.0ms
Math + raw HTML | 5848 | 512 | Michi current | 117.1ms | 56.9ms | 74.2ms | 9.2ms | 0 | 0 | 14.4ms
Long footnotes | 11120 | 512 | Streamdown featured | 474.8ms | 274.2ms | 332.7ms | 25.5ms | 2 | 0 | 16.3ms
Long footnotes | 11120 | 512 | Michi current | 84.4ms | 0.5ms | 34.6ms | 9.2ms | 0 | 0 | 26.4ms
Long footnotes | 11120 | 512 | Streamdown core | 245.7ms | 169.9ms | 107.9ms | 16.7ms | 0 | 0 | 1.0ms

## Michi semantic snapshot lag during streaming

Fixture | chunk | semantic snapshots | average lag | max lag
--- | ---: | ---: | ---: | ---:
Prose + CJK | 128 | 3 | 2457.0 chars | 5248 chars
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
Prose + CJK | 11311 | Michi current | 32.8ms | 0.0ms | 25.0ms | 25.4ms | 197
Prose + CJK | 11311 | Streamdown core | 38.1ms | 0.1ms | 28.6ms | 29.2ms | 225
Prose + CJK | 11311 | Streamdown featured | 37.7ms | 0.1ms | 29.9ms | 30.2ms | 225
GFM structure | 6001 | Streamdown core | 42.3ms | 0.1ms | 35.1ms | 35.5ms | 540
GFM structure | 6001 | Streamdown featured | 36.5ms | 0.1ms | 30.4ms | 30.9ms | 540
GFM structure | 6001 | Michi current | 34.4ms | 0.1ms | 26.5ms | 26.7ms | 510
Code-heavy | 22542 | Streamdown featured | 233.5ms | 41.8ms | 55.1ms | 19.5ms | 6673
Code-heavy | 22542 | Michi current | 204.2ms | 36.3ms | 49.9ms | 17.0ms | 6753
Code-heavy | 22542 | Streamdown core | 30.8ms | 0.1ms | 20.6ms | 20.9ms | 881
Math + raw HTML | 5848 | Michi current | 92.7ms | 50.0ms | 63.5ms | 16.2ms | 3453
Math + raw HTML | 5848 | Streamdown core | 18.1ms | 0.1ms | 13.4ms | 13.5ms | 145
Math + raw HTML | 5848 | Streamdown featured | 70.0ms | 0.0ms | 45.9ms | 46.6ms | 3723
Long footnotes | 11120 | Streamdown core | 39.9ms | 0.1ms | 30.8ms | 31.1ms | 481
Long footnotes | 11120 | Streamdown featured | 42.4ms | 0.1ms | 33.5ms | 34.1ms | 481
Long footnotes | 11120 | Michi current | 36.3ms | 0.1ms | 27.9ms | 28.2ms | 481

## Instrumentation notes

- Michi current uses the repository components unchanged: 3Hz Markdown reinterpretation, incremental unstable-tail lexing, one-character reveal, then a full non-streaming render at completion.
- Streamdown core disables optional code/math/CJK plugins and animation.
- Streamdown featured enables code, math (single-dollar inline math), CJK, and its recommended animation. Controls and link-safety UI are disabled for both Streamdown modes.
- Task/Script/Layout metrics come from Chrome DevTools Protocol. React Profiler time and frame intervals come from the page harness. Module loading and the first async syntax-highlighter initialization are warmed before measurement.
- Michi semantic lag counts source characters waiting for the next 3Hz Markdown reinterpretation. Those characters are still visible immediately as the plain-text pending tail; only their Markdown semantics lag.
- Code fixtures use equal-length unique source markers for every measured document so syntax-highlighting result caches cannot make later samples artificially cheap.
