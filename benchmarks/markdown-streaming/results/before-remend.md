# Michi vs Streamdown local benchmark

Generated: 2026-08-05T08:35:33.109Z
Browser: 148.0.7778.96
Machine: darwin / arm64
Streamdown: 2.5.0; repeats: 3; paced updates: one per requestAnimationFrame

## Suite summary (sum of fixture medians)

Suite | Michi task CPU | Streamdown core | core / Michi | Streamdown featured | featured / Michi
--- | ---: | ---: | ---: | ---: | ---:
Streaming, 128 chars/update | 1350.9ms | 4738.1ms | 3.51x | 7413.5ms | 5.49x
Streaming, 512 chars/update | 681.5ms | 1404.3ms | 2.06x | 2789.3ms | 4.09x
Static suite, one new document | 413.4ms | 181.0ms | 0.44x | 424.4ms | 1.03x

## Streaming CPU (median)

Fixture | chars | chunk | Renderer | Task CPU | Script CPU | Profiler | frame p95 | >25ms frames | long tasks | final render
--- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---:
Prose + CJK | 11311 | 128 | Michi current | 245.5ms | 38.8ms | 73.4ms | 9.3ms | 0 | 0 | 18.3ms
Prose + CJK | 11311 | 128 | Streamdown core | 320.1ms | 113.9ms | 226.7ms | 8.5ms | 0 | 0 | 0.9ms
Prose + CJK | 11311 | 128 | Streamdown featured | 584.5ms | 158.6ms | 282.2ms | 8.8ms | 0 | 0 | 24.6ms
GFM structure | 6001 | 128 | Streamdown core | 181.5ms | 80.5ms | 124.6ms | 8.9ms | 0 | 0 | 0.8ms
GFM structure | 6001 | 128 | Streamdown featured | 329.2ms | 103.7ms | 164.7ms | 8.5ms | 0 | 0 | 21.9ms
GFM structure | 6001 | 128 | Michi current | 129.9ms | 29.4ms | 57.2ms | 9.1ms | 0 | 0 | 21.2ms
Code-heavy | 22542 | 128 | Streamdown featured | 4790.6ms | 390.8ms | 3421.7ms | 58.3ms | 77 | 1 | 15.2ms
Code-heavy | 22542 | 128 | Michi current | 524.6ms | 120.5ms | 168.4ms | 9.2ms | 0 | 0 | 15.6ms
Code-heavy | 22542 | 128 | Streamdown core | 3329.0ms | 192.8ms | 3196.6ms | 49.9ms | 51 | 2 | 0.8ms
Math + raw HTML | 5848 | 128 | Michi current | 248.2ms | 121.7ms | 142.4ms | 9.1ms | 1 | 0 | 13.0ms
Math + raw HTML | 5848 | 128 | Streamdown core | 115.7ms | 56.5ms | 77.9ms | 9.1ms | 0 | 0 | 0.7ms
Math + raw HTML | 5848 | 128 | Streamdown featured | 476.8ms | 125.5ms | 179.9ms | 14.3ms | 0 | 0 | 41.0ms
Long footnotes | 11120 | 128 | Streamdown core | 791.8ms | 585.5ms | 363.4ms | 16.8ms | 0 | 0 | 1.1ms
Long footnotes | 11120 | 128 | Streamdown featured | 1232.5ms | 883.5ms | 1043.9ms | 25.0ms | 4 | 0 | 14.8ms
Long footnotes | 11120 | 128 | Michi current | 202.7ms | 37.1ms | 68.9ms | 8.7ms | 0 | 0 | 20.9ms
Prose + CJK | 11311 | 512 | Streamdown core | 120.8ms | 56.5ms | 91.3ms | 9.3ms | 0 | 0 | 1.0ms
Prose + CJK | 11311 | 512 | Streamdown featured | 342.7ms | 87.5ms | 144.4ms | 16.7ms | 0 | 0 | 25.8ms
Prose + CJK | 11311 | 512 | Michi current | 99.4ms | 0.3ms | 29.1ms | 8.9ms | 0 | 0 | 21.9ms
GFM structure | 6001 | 512 | Streamdown featured | 205.8ms | 64.1ms | 102.5ms | 16.9ms | 0 | 0 | 25.3ms
GFM structure | 6001 | 512 | Michi current | 57.1ms | 0.2ms | 27.8ms | 8.5ms | 0 | 0 | 22.4ms
GFM structure | 6001 | 512 | Streamdown core | 76.4ms | 41.9ms | 57.1ms | 8.6ms | 0 | 0 | 0.7ms
Code-heavy | 22542 | 512 | Michi current | 320.4ms | 58.3ms | 76.7ms | 9.0ms | 0 | 0 | 12.8ms
Code-heavy | 22542 | 512 | Streamdown core | 922.3ms | 63.3ms | 873.7ms | 50.0ms | 13 | 0 | 0.8ms
Code-heavy | 22542 | 512 | Streamdown featured | 1487.2ms | 144.5ms | 967.0ms | 58.4ms | 25 | 2 | 10.5ms
Math + raw HTML | 5848 | 512 | Streamdown core | 49.6ms | 26.5ms | 34.7ms | 9.0ms | 0 | 0 | 0.7ms
Math + raw HTML | 5848 | 512 | Streamdown featured | 285.2ms | 96.2ms | 147.6ms | 25.0ms | 0 | 1 | 44.1ms
Math + raw HTML | 5848 | 512 | Michi current | 119.3ms | 57.1ms | 74.7ms | 9.1ms | 0 | 0 | 13.7ms
Long footnotes | 11120 | 512 | Streamdown featured | 468.4ms | 272.3ms | 332.1ms | 29.3ms | 3 | 0 | 16.7ms
Long footnotes | 11120 | 512 | Michi current | 85.3ms | 0.5ms | 30.6ms | 8.5ms | 0 | 0 | 25.1ms
Long footnotes | 11120 | 512 | Streamdown core | 235.1ms | 164.5ms | 102.3ms | 16.8ms | 0 | 0 | 1.2ms

## Michi semantic snapshot lag during streaming

Fixture | chunk | semantic snapshots | average lag | max lag
--- | ---: | ---: | ---: | ---:
Prose + CJK | 128 | 3 | 2409.5 chars | 5120 chars
GFM structure | 128 | 2 | 2290.1 chars | 5120 chars
Code-heavy | 128 | 5 | 2453.1 chars | 5120 chars
Math + raw HTML | 128 | 2 | 2422.8 chars | 5248 chars
Long footnotes | 128 | 3 | 2443.6 chars | 5120 chars
Prose + CJK | 512 | 1 | 5611.8 chars | 10799 chars
GFM structure | 512 | 1 | 2804.1 chars | 5489 chars
Code-heavy | 512 | 2 | 9432.5 chars | 20480 chars
Math + raw HTML | 512 | 1 | 2791.3 chars | 5336 chars
Long footnotes | 512 | 1 | 5369.5 chars | 10608 chars

## Static full-document render (one new document, median)

Fixture | chars | Renderer | Task CPU | Script CPU | Profiler | render call p95 | DOM nodes
--- | ---: | --- | ---: | ---: | ---: | ---: | ---:
Prose + CJK | 11311 | Michi current | 33.1ms | 0.1ms | 25.6ms | 25.9ms | 197
Prose + CJK | 11311 | Streamdown core | 44.0ms | 0.1ms | 33.7ms | 34.2ms | 225
Prose + CJK | 11311 | Streamdown featured | 34.3ms | 0.1ms | 27.6ms | 27.7ms | 225
GFM structure | 6001 | Streamdown core | 40.1ms | 0.1ms | 31.5ms | 32.1ms | 540
GFM structure | 6001 | Streamdown featured | 40.2ms | 0.1ms | 32.0ms | 32.5ms | 540
GFM structure | 6001 | Michi current | 38.5ms | 0.0ms | 30.4ms | 30.9ms | 510
Code-heavy | 22542 | Streamdown featured | 231.3ms | 40.6ms | 52.8ms | 19.2ms | 6673
Code-heavy | 22542 | Michi current | 208.5ms | 35.9ms | 49.7ms | 17.8ms | 6753
Code-heavy | 22542 | Streamdown core | 31.3ms | 0.1ms | 21.1ms | 21.7ms | 881
Math + raw HTML | 5848 | Michi current | 93.7ms | 49.5ms | 62.9ms | 16.1ms | 3453
Math + raw HTML | 5848 | Streamdown core | 19.2ms | 0.1ms | 14.4ms | 14.7ms | 145
Math + raw HTML | 5848 | Streamdown featured | 71.7ms | 0.1ms | 47.8ms | 48.1ms | 3723
Long footnotes | 11120 | Streamdown core | 46.3ms | 0.1ms | 32.7ms | 33.4ms | 481
Long footnotes | 11120 | Streamdown featured | 47.0ms | 0.1ms | 36.1ms | 36.4ms | 481
Long footnotes | 11120 | Michi current | 39.5ms | 0.1ms | 30.0ms | 30.4ms | 481

## Instrumentation notes

- Michi current uses the repository components unchanged: 3Hz Markdown reinterpretation, incremental unstable-tail lexing, one-character reveal, then a full non-streaming render at completion.
- Streamdown core disables optional code/math/CJK plugins and animation.
- Streamdown featured enables code, math (single-dollar inline math), CJK, and its recommended animation. Controls and link-safety UI are disabled for both Streamdown modes.
- Task/Script/Layout metrics come from Chrome DevTools Protocol. React Profiler time and frame intervals come from the page harness. Module loading and the first async syntax-highlighter initialization are warmed before measurement.
- Michi semantic lag counts source characters waiting for the next 3Hz Markdown reinterpretation. Those characters are still visible immediately as the plain-text pending tail; only their Markdown semantics lag.
- Code fixtures use equal-length unique source markers for every measured document so syntax-highlighting result caches cannot make later samples artificially cheap.
