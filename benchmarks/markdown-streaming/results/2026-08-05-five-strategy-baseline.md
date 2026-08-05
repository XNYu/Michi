# Streaming Markdown strategy comparison

Generated: 2026-08-05T12:08:28.015Z
Browser: 148.0.7778.96
Machine: darwin / arm64
Streamdown: 2.5.0; repeats: 3; each update paced by requestAnimationFrame

## Streaming summary — 128 chars/update

Strategy | Task CPU total | Script CPU total | Wall total | React render total | render call p95 worst | frame p95 worst | >25ms frames | long tasks | semantic lag avg / max
--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:
Michi adaptive (max 1s) | 2007.9ms | 1081.2ms | 4980.2ms | 1197.7ms | 1.0ms | 16.8ms | 0 | 0 | 362.7 / 2560 chars
Michi fixed 1Hz | 1174.1ms | 140.1ms | 4881.4ms | 376.0ms | 1.8ms | 9.7ms | 0 | 0 | 4672.3 / 15360 chars
Michi fixed 3Hz | 1257.0ms | 320.3ms | 4897.6ms | 514.3ms | 1.2ms | 10.2ms | 1 | 0 | 2407.4 / 5248 chars
Streamdown Word | 7478.5ms | 1675.4ms | 8653.3ms | 5179.2ms | 45.7ms | 58.4ms | 87 | 3 | n/a
Streamdown Char | 11958.9ms | 3685.1ms | 12523.5ms | 7152.1ms | 47.0ms | 67.7ms | 166 | 14 | n/a

## Streaming summary — 512 chars/update

Strategy | Task CPU total | Script CPU total | Wall total | React render total | render call p95 worst | frame p95 worst | >25ms frames | long tasks | semantic lag avg / max
--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:
Michi adaptive (max 1s) | 1059.6ms | 516.5ms | 2089.5ms | 608.6ms | 18.0ms | 16.7ms | 0 | 0 | 650.7 / 2560 chars
Michi fixed 1Hz | 637.8ms | 100.6ms | 2258.7ms | 252.2ms | 23.6ms | 10.2ms | 0 | 0 | 5565.9 / 22030 chars
Michi fixed 3Hz | 680.0ms | 113.7ms | 2287.4ms | 260.4ms | 22.4ms | 9.9ms | 0 | 0 | 5201.8 / 20480 chars
Streamdown Word | 2830.0ms | 676.0ms | 3463.9ms | 1731.3ms | 46.0ms | 58.3ms | 29 | 3 | n/a
Streamdown Char | 5144.6ms | 1313.7ms | 5493.8ms | 2361.8ms | 46.5ms | 83.5ms | 69 | 8 | n/a

## Streaming detail (fixture medians)

Fixture | chunk | Strategy | Task CPU | Script CPU | wall | render total | render p95 | frame p95 / max | >25ms | long tasks | final render
--- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:
Prose + CJK | 128 | Michi adaptive (max 1s) | 284.8ms | 90.2ms | 931.9ms | 118.8ms | 0.7ms | 8.7 / 9.5ms | 0 | 0 | 18.7ms
Prose + CJK | 128 | Michi fixed 1Hz | 201.7ms | 2.6ms | 942.0ms | 69.5ms | 1.1ms | 8.8 / 10.2ms | 0 | 0 | 22.1ms
Prose + CJK | 128 | Michi fixed 3Hz | 211.8ms | 36.4ms | 944.7ms | 87.4ms | 0.8ms | 9.6 / 16.6ms | 0 | 0 | 19.6ms
Prose + CJK | 128 | Streamdown Word | 598.0ms | 159.7ms | 951.0ms | 288.0ms | 3.2ms | 9.4 / 10.3ms | 0 | 0 | 25.0ms
Prose + CJK | 128 | Streamdown Char | 1759.1ms | 311.8ms | 1903.0ms | 418.1ms | 3.7ms | 33.2 / 41.7ms | 18 | 0 | 25.5ms
GFM structure | 128 | Michi fixed 1Hz | 132.5ms | 0.7ms | 585.4ms | 48.3ms | 1.8ms | 9.6 / 10.2ms | 0 | 0 | 25.0ms
GFM structure | 128 | Michi fixed 3Hz | 137.7ms | 27.6ms | 599.0ms | 66.3ms | 0.9ms | 9.9 / 16.7ms | 0 | 0 | 21.7ms
GFM structure | 128 | Streamdown Word | 347.1ms | 109.4ms | 594.4ms | 176.7ms | 2.4ms | 10.0 / 10.2ms | 0 | 0 | 23.2ms
GFM structure | 128 | Streamdown Char | 772.8ms | 167.9ms | 808.1ms | 228.1ms | 2.6ms | 17.0 / 18.1ms | 0 | 0 | 24.5ms
GFM structure | 128 | Michi adaptive (max 1s) | 170.1ms | 66.7ms | 590.3ms | 91.0ms | 0.6ms | 9.9 / 10.2ms | 0 | 0 | 19.7ms
Code-heavy | 128 | Michi fixed 3Hz | 484.9ms | 101.7ms | 1741.2ms | 149.8ms | 1.2ms | 10.1 / 16.7ms | 0 | 0 | 17.0ms
Code-heavy | 128 | Streamdown Word | 4851.6ms | 391.5ms | 5039.3ms | 3476.1ms | 45.7ms | 58.4 / 67.2ms | 81 | 2 | 14.0ms
Code-heavy | 128 | Streamdown Char | 5000.0ms | 412.6ms | 5171.9ms | 3512.5ms | 47.0ms | 58.7 / 75.0ms | 86 | 3 | 11.5ms
Code-heavy | 128 | Michi adaptive (max 1s) | 447.8ms | 117.2ms | 1733.4ms | 158.7ms | 1.0ms | 10.2 / 16.7ms | 0 | 0 | 15.2ms
Code-heavy | 128 | Michi fixed 1Hz | 496.0ms | 76.6ms | 1807.4ms | 129.7ms | 1.1ms | 9.7 / 10.3ms | 0 | 0 | 16.8ms
Math + raw HTML | 128 | Streamdown Word | 464.9ms | 142.4ms | 637.0ms | 202.9ms | 1.7ms | 15.4 / 17.2ms | 0 | 1 | 42.8ms
Math + raw HTML | 128 | Streamdown Char | 630.2ms | 167.2ms | 751.0ms | 223.3ms | 1.2ms | 17.8 / 17.9ms | 0 | 1 | 42.6ms
Math + raw HTML | 128 | Michi adaptive (max 1s) | 312.5ms | 175.7ms | 631.6ms | 181.0ms | 0.5ms | 9.7 / 9.9ms | 0 | 0 | 13.2ms
Math + raw HTML | 128 | Michi fixed 1Hz | 154.3ms | 57.9ms | 623.9ms | 80.6ms | 0.6ms | 9.7 / 9.8ms | 0 | 0 | 15.7ms
Math + raw HTML | 128 | Michi fixed 3Hz | 226.8ms | 118.0ms | 677.5ms | 135.1ms | 1.0ms | 10.0 / 50.2ms | 1 | 0 | 13.8ms
Long footnotes | 128 | Streamdown Char | 3796.7ms | 2625.7ms | 3889.5ms | 2770.1ms | 8.0ms | 67.7 / 74.9ms | 62 | 10 | 15.3ms
Long footnotes | 128 | Michi adaptive (max 1s) | 792.8ms | 631.4ms | 1093.0ms | 648.2ms | 0.5ms | 16.8 / 24.0ms | 0 | 0 | 16.7ms
Long footnotes | 128 | Michi fixed 1Hz | 189.7ms | 2.3ms | 922.7ms | 47.9ms | 0.6ms | 9.7 / 10.1ms | 0 | 0 | 26.8ms
Long footnotes | 128 | Michi fixed 3Hz | 195.9ms | 36.6ms | 935.2ms | 75.7ms | 0.5ms | 10.2 / 16.8ms | 0 | 0 | 21.2ms
Long footnotes | 128 | Streamdown Word | 1216.9ms | 872.5ms | 1431.6ms | 1035.5ms | 6.0ms | 25.3 / 33.4ms | 6 | 0 | 15.0ms
Prose + CJK | 512 | Michi fixed 1Hz | 81.2ms | 0.4ms | 390.8ms | 39.5ms | 4.2ms | 9.5 / 9.5ms | 0 | 0 | 22.1ms
Prose + CJK | 512 | Michi fixed 3Hz | 91.8ms | 0.6ms | 392.2ms | 39.1ms | 4.3ms | 9.9 / 10.2ms | 0 | 0 | 22.0ms
Prose + CJK | 512 | Streamdown Word | 362.0ms | 94.2ms | 462.0ms | 154.3ms | 6.1ms | 17.0 / 17.1ms | 0 | 0 | 26.5ms
Prose + CJK | 512 | Streamdown Char | 1096.7ms | 193.8ms | 1181.4ms | 246.1ms | 10.4ms | 58.3 / 58.9ms | 18 | 1 | 28.3ms
Prose + CJK | 512 | Michi adaptive (max 1s) | 135.0ms | 56.4ms | 384.3ms | 77.7ms | 4.0ms | 9.6 / 9.7ms | 0 | 0 | 17.0ms
GFM structure | 512 | Michi fixed 3Hz | 66.9ms | 0.3ms | 303.5ms | 33.1ms | 22.4ms | 9.4 / 9.4ms | 0 | 0 | 22.4ms
GFM structure | 512 | Streamdown Word | 223.3ms | 66.8ms | 343.3ms | 114.5ms | 25.5ms | 16.7 / 16.7ms | 0 | 0 | 25.5ms
GFM structure | 512 | Streamdown Char | 497.3ms | 102.2ms | 516.6ms | 148.6ms | 23.9ms | 33.3 / 33.3ms | 3 | 0 | 23.9ms
GFM structure | 512 | Michi adaptive (max 1s) | 98.1ms | 40.4ms | 287.9ms | 62.9ms | 18.0ms | 9.4 / 9.4ms | 0 | 0 | 18.0ms
GFM structure | 512 | Michi fixed 1Hz | 56.9ms | 0.3ms | 303.3ms | 34.2ms | 23.6ms | 9.6 / 9.6ms | 0 | 0 | 23.6ms
Code-heavy | 512 | Streamdown Word | 1496.4ms | 148.8ms | 1655.5ms | 982.8ms | 46.0ms | 58.3 / 66.8ms | 27 | 2 | 11.0ms
Code-heavy | 512 | Streamdown Char | 1563.8ms | 159.2ms | 1694.6ms | 992.2ms | 46.5ms | 58.7 / 67.1ms | 27 | 3 | 10.8ms
Code-heavy | 512 | Michi adaptive (max 1s) | 329.9ms | 98.0ms | 613.6ms | 113.5ms | 0.6ms | 9.8 / 16.7ms | 0 | 0 | 14.2ms
Code-heavy | 512 | Michi fixed 1Hz | 296.5ms | 37.3ms | 826.3ms | 65.9ms | 0.7ms | 9.6 / 10.0ms | 0 | 0 | 16.2ms
Code-heavy | 512 | Michi fixed 3Hz | 313.5ms | 58.7ms | 883.9ms | 82.8ms | 0.7ms | 9.5 / 17.0ms | 0 | 0 | 13.3ms
Math + raw HTML | 512 | Streamdown Char | 387.0ms | 113.1ms | 495.2ms | 165.1ms | 42.3ms | 33.3 / 33.3ms | 3 | 1 | 42.3ms
Math + raw HTML | 512 | Michi adaptive (max 1s) | 206.5ms | 124.2ms | 367.7ms | 137.7ms | 13.2ms | 16.2 / 16.2ms | 0 | 0 | 13.2ms
Math + raw HTML | 512 | Michi fixed 1Hz | 126.6ms | 61.9ms | 350.0ms | 78.2ms | 13.9ms | 10.2 / 10.2ms | 0 | 0 | 13.9ms
Math + raw HTML | 512 | Michi fixed 3Hz | 122.2ms | 53.4ms | 326.9ms | 71.6ms | 13.4ms | 9.4 / 9.4ms | 0 | 0 | 13.4ms
Math + raw HTML | 512 | Streamdown Word | 282.0ms | 93.0ms | 419.0ms | 147.9ms | 43.3ms | 24.4 / 24.4ms | 0 | 1 | 43.3ms
Long footnotes | 512 | Michi adaptive (max 1s) | 290.1ms | 197.6ms | 436.0ms | 216.8ms | 2.6ms | 16.7 / 16.8ms | 0 | 0 | 17.1ms
Long footnotes | 512 | Michi fixed 1Hz | 76.6ms | 0.6ms | 388.3ms | 34.4ms | 2.7ms | 8.6 / 9.9ms | 0 | 0 | 26.1ms
Long footnotes | 512 | Michi fixed 3Hz | 85.6ms | 0.6ms | 380.9ms | 33.8ms | 2.8ms | 9.4 / 9.4ms | 0 | 0 | 25.6ms
Long footnotes | 512 | Streamdown Word | 466.4ms | 273.1ms | 584.1ms | 331.8ms | 6.7ms | 33.3 / 33.4ms | 2 | 0 | 17.3ms
Long footnotes | 512 | Streamdown Char | 1599.8ms | 745.3ms | 1606.0ms | 809.8ms | 10.6ms | 83.5 / 99.8ms | 18 | 3 | 18.9ms

## Michi semantic snapshot lag

Fixture | chunk | Strategy | semantic snapshots | average lag | max lag
--- | ---: | --- | ---: | ---: | ---:
Prose + CJK | 128 | Michi adaptive (max 1s) | 61 | 164.5 chars | 256 chars
Prose + CJK | 128 | Michi fixed 1Hz | 1 | 5631.1 chars | 11183 chars
Prose + CJK | 128 | Michi fixed 3Hz | 3 | 2409.5 chars | 5120 chars
GFM structure | 128 | Michi fixed 1Hz | 1 | 2943.7 chars | 5873 chars
GFM structure | 128 | Michi fixed 3Hz | 2 | 2290.1 chars | 5120 chars
GFM structure | 128 | Michi adaptive (max 1s) | 40 | 141.3 chars | 256 chars
Code-heavy | 128 | Michi fixed 3Hz | 5 | 2469.7 chars | 5120 chars
Code-heavy | 128 | Michi adaptive (max 1s) | 24 | 1225.8 chars | 2560 chars
Code-heavy | 128 | Michi fixed 1Hz | 2 | 6403.7 chars | 15360 chars
Math + raw HTML | 128 | Michi adaptive (max 1s) | 39 | 141.0 chars | 256 chars
Math + raw HTML | 128 | Michi fixed 1Hz | 1 | 2879.1 chars | 5720 chars
Math + raw HTML | 128 | Michi fixed 3Hz | 2 | 2422.8 chars | 5248 chars
Long footnotes | 128 | Michi adaptive (max 1s) | 76 | 141.1 chars | 256 chars
Long footnotes | 128 | Michi fixed 1Hz | 1 | 5503.8 chars | 10992 chars
Long footnotes | 128 | Michi fixed 3Hz | 3 | 2445.1 chars | 5248 chars
Prose + CJK | 512 | Michi fixed 1Hz | 1 | 5611.8 chars | 10799 chars
Prose + CJK | 512 | Michi fixed 3Hz | 1 | 5611.8 chars | 10799 chars
Prose + CJK | 512 | Michi adaptive (max 1s) | 22 | 469.5 chars | 512 chars
GFM structure | 512 | Michi fixed 3Hz | 1 | 2804.1 chars | 5489 chars
GFM structure | 512 | Michi adaptive (max 1s) | 11 | 457.4 chars | 512 chars
GFM structure | 512 | Michi fixed 1Hz | 1 | 2804.1 chars | 5489 chars
Code-heavy | 512 | Michi adaptive (max 1s) | 12 | 1399.8 chars | 2560 chars
Code-heavy | 512 | Michi fixed 1Hz | 1 | 11252.9 chars | 22030 chars
Code-heavy | 512 | Michi fixed 3Hz | 2 | 9432.5 chars | 20480 chars
Math + raw HTML | 512 | Michi adaptive (max 1s) | 11 | 444.7 chars | 512 chars
Math + raw HTML | 512 | Michi fixed 1Hz | 1 | 2791.3 chars | 5336 chars
Math + raw HTML | 512 | Michi fixed 3Hz | 1 | 2791.3 chars | 5336 chars
Long footnotes | 512 | Michi adaptive (max 1s) | 21 | 482.2 chars | 512 chars
Long footnotes | 512 | Michi fixed 1Hz | 1 | 5369.5 chars | 10608 chars
Long footnotes | 512 | Michi fixed 3Hz | 1 | 5369.5 chars | 10608 chars

## Static full-document render (one new document, median)

Fixture | chars | Strategy | Task CPU | Script CPU | wall | Profiler | render call | DOM nodes
--- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---:
Prose + CJK | 11311 | Michi adaptive (max 1s) | 31.3ms | 0.0ms | 196.0ms | 24.4ms | 24.6ms | 197
Prose + CJK | 11311 | Michi fixed 1Hz | 31.3ms | 0.0ms | 193.7ms | 23.9ms | 24.2ms | 197
Prose + CJK | 11311 | Michi fixed 3Hz | 30.5ms | 0.1ms | 193.3ms | 23.7ms | 24.0ms | 197
Prose + CJK | 11311 | Streamdown Word | 33.4ms | 0.1ms | 198.7ms | 26.5ms | 26.5ms | 225
Prose + CJK | 11311 | Streamdown Char | 33.2ms | 0.1ms | 195.8ms | 26.0ms | 26.3ms | 225
GFM structure | 6001 | Michi fixed 1Hz | 30.1ms | 0.1ms | 194.5ms | 23.9ms | 24.0ms | 510
GFM structure | 6001 | Michi fixed 3Hz | 30.1ms | 0.0ms | 195.7ms | 24.0ms | 24.4ms | 510
GFM structure | 6001 | Streamdown Word | 36.4ms | 0.0ms | 196.9ms | 30.7ms | 30.8ms | 540
GFM structure | 6001 | Streamdown Char | 35.0ms | 0.0ms | 200.4ms | 29.1ms | 29.2ms | 540
GFM structure | 6001 | Michi adaptive (max 1s) | 30.7ms | 0.1ms | 191.5ms | 24.3ms | 24.5ms | 510
Code-heavy | 22542 | Michi fixed 3Hz | 203.1ms | 36.4ms | 403.7ms | 50.1ms | 16.9ms | 6753
Code-heavy | 22542 | Streamdown Word | 222.5ms | 39.2ms | 367.7ms | 51.8ms | 18.3ms | 6673
Code-heavy | 22542 | Streamdown Char | 210.4ms | 39.8ms | 350.7ms | 51.6ms | 17.9ms | 6673
Code-heavy | 22542 | Michi adaptive (max 1s) | 204.1ms | 33.8ms | 402.1ms | 47.0ms | 15.9ms | 6753
Code-heavy | 22542 | Michi fixed 1Hz | 202.6ms | 34.8ms | 483.6ms | 47.2ms | 16.2ms | 6753
Math + raw HTML | 5848 | Streamdown Word | 73.3ms | 0.1ms | 216.0ms | 46.8ms | 47.6ms | 3723
Math + raw HTML | 5848 | Streamdown Char | 69.6ms | 0.1ms | 216.5ms | 46.4ms | 46.8ms | 3723
Math + raw HTML | 5848 | Michi adaptive (max 1s) | 90.7ms | 49.2ms | 247.1ms | 62.5ms | 15.4ms | 3453
Math + raw HTML | 5848 | Michi fixed 1Hz | 89.6ms | 47.4ms | 228.9ms | 60.5ms | 15.3ms | 3453
Math + raw HTML | 5848 | Michi fixed 3Hz | 90.9ms | 48.1ms | 231.8ms | 61.1ms | 15.4ms | 3453
Long footnotes | 11120 | Streamdown Char | 40.7ms | 0.0ms | 203.7ms | 32.2ms | 32.5ms | 481
Long footnotes | 11120 | Michi adaptive (max 1s) | 36.9ms | 0.1ms | 196.9ms | 28.3ms | 28.7ms | 481
Long footnotes | 11120 | Michi fixed 1Hz | 35.6ms | 0.0ms | 200.1ms | 27.2ms | 27.4ms | 481
Long footnotes | 11120 | Michi fixed 3Hz | 36.6ms | 0.1ms | 198.2ms | 27.6ms | 28.1ms | 481
Long footnotes | 11120 | Streamdown Word | 39.7ms | 0.0ms | 198.7ms | 31.0ms | 31.4ms | 481

## Instrumentation notes

- Michi adaptive reparses immediately at paragraph breaks and completed Markdown structure lines (heading, list, quote, fence, math block, table delimiter, footnote/link definition, selected HTML blocks), when pending text reaches 4096 chars, or after 1 second at the latest.
- Michi fixed modes use identical incremental unstable-tail rendering and Remend behavior; only semantic snapshot frequency differs (1Hz vs 3Hz).
- Streamdown Word and Char both enable the same code, math (single-dollar inline math), and CJK plugins. Only animation segmentation differs (`sep: word` vs `sep: char`). Controls and link-safety UI are disabled.
- Task/Script/Layout metrics come from Chrome DevTools Protocol. React Profiler time and frame intervals come from the page harness. Module loading and the first async syntax-highlighter initialization are warmed before measurement.
- Michi semantic lag counts source characters waiting for the next Markdown reinterpretation. Pending characters remain visible immediately through the lightweight tail renderer; only full Markdown semantics lag.
- Wall time includes final async highlighting and a 150ms DOM quiet window, so Task CPU and render-call latency are the cleaner measures of main-thread cost.
- Code fixtures use equal-length unique source markers for every measured document so syntax-highlighting result caches cannot make later samples artificially cheap.
