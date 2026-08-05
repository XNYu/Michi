# Streaming Markdown full-feature parity comparison

Generated: 2026-08-05T13:05:09.052Z
Browser: 148.0.7778.96
Machine: darwin / arm64
Streamdown: 2.5.0; repeats: 3; each update paced by requestAnimationFrame

## Streaming summary — 128 chars/update

Strategy | Task CPU total | Script CPU total | Wall total | React render total | render call p95 worst | frame p95 worst | >25ms frames | long tasks | semantic lag avg / max
--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:
Michi 3Hz core | 2087.5ms | 435.1ms | 5615.8ms | 717.2ms | 3.2ms | 16.6ms | 6 | 2 | 2255.0 / 5120 chars
Michi 3Hz full features | 1947.1ms | 437.5ms | 5623.5ms | 697.9ms | 4.7ms | 9.3ms | 3 | 2 | 2260.7 / 5120 chars
Streamdown Word core | 8927.6ms | 2283.6ms | 9918.3ms | 5932.9ms | 46.8ms | 58.6ms | 112 | 6 | n/a
Streamdown Word full features | 9560.4ms | 2281.2ms | 11644.3ms | 6055.4ms | 47.9ms | 58.6ms | 107 | 9 | n/a
Streamdown Char full features | 18635.5ms | 5006.4ms | 20208.6ms | 8659.2ms | 47.8ms | 91.8ms | 233 | 47 | n/a

## Streaming summary — 512 chars/update

Strategy | Task CPU total | Script CPU total | Wall total | React render total | render call p95 worst | frame p95 worst | >25ms frames | long tasks | semantic lag avg / max
--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:
Michi 3Hz core | 966.4ms | 144.3ms | 2731.6ms | 352.8ms | 26.6ms | 9.3ms | 0 | 0 | 4627.5 / 20480 chars
Michi 3Hz full features | 941.9ms | 142.1ms | 2684.5ms | 346.5ms | 26.3ms | 9.2ms | 0 | 0 | 4627.5 / 20480 chars
Streamdown Word core | 3602.0ms | 884.0ms | 4242.6ms | 2078.8ms | 68.9ms | 58.6ms | 40 | 5 | n/a
Streamdown Word full features | 3836.9ms | 932.6ms | 5648.6ms | 2088.9ms | 64.4ms | 65.9ms | 41 | 7 | n/a
Streamdown Char full features | 8351.5ms | 1811.6ms | 9500.5ms | 2995.2ms | 66.2ms | 116.6ms | 87 | 34 | n/a

## Feature overhead and head-to-head CPU

Chunk | Michi full / core (feature fixture) | Streamdown Word full / core (feature fixture) | Michi full / Streamdown Word full (feature fixture) | Michi full / Streamdown Word full (all fixtures)
---: | ---: | ---: | ---: | ---:
128 chars/update | 1.41x | 1.99x | 0.29x | 0.20x
512 chars/update | 1.55x | 3.63x | 0.23x | 0.25x

## Rendered feature audit (full feature fixture, static median)

Strategy | CJK strong | CJK delete | code actions | numbered lines | table actions | Mermaid SVGs | direction | DOM nodes
--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:
Michi 3Hz core | 0 | 0 | 9 | 0 | 0 | 0 | 0 | 922
Michi 3Hz full features | 4 | 4 | 8 | 52 | 12 | 4 | 1 | 1212
Streamdown Word core | 4 | 4 | 0 | 0 | 0 | 0 | 0 | 914
Streamdown Word full features | 4 | 4 | 14 | 53 | 12 | 4 | 1 | 1418
Streamdown Char full features | 4 | 4 | 14 | 53 | 12 | 4 | 1 | 1418
## Streaming detail (fixture medians)

Fixture | chunk | Strategy | Task CPU | Script CPU | wall | render total | render p95 | frame p95 / max | >25ms | long tasks | final render
--- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:
Prose + CJK | 128 | Michi 3Hz core | 486.3ms | 54.7ms | 1054.6ms | 119.1ms | 1.7ms | 16.6 / 50.6ms | 2 | 0 | 21.5ms
Prose + CJK | 128 | Michi 3Hz full features | 448.4ms | 49.6ms | 1018.9ms | 112.8ms | 1.6ms | 9.2 / 33.4ms | 1 | 0 | 21.2ms
Prose + CJK | 128 | Streamdown Word core | 817.3ms | 208.2ms | 992.2ms | 356.5ms | 3.8ms | 16.6 / 17.3ms | 0 | 0 | 33.0ms
Prose + CJK | 128 | Streamdown Word full features | 791.1ms | 201.8ms | 1005.1ms | 342.2ms | 3.8ms | 16.3 / 17.5ms | 0 | 1 | 27.7ms
Prose + CJK | 128 | Streamdown Char full features | 3566.9ms | 418.8ms | 3960.4ms | 611.2ms | 4.5ms | 50.5 / 75.4ms | 41 | 2 | 54.5ms
GFM structure | 128 | Michi 3Hz full features | 185.7ms | 39.6ms | 610.0ms | 81.5ms | 1.1ms | 9.2 / 32.9ms | 1 | 0 | 21.5ms
GFM structure | 128 | Streamdown Word core | 440.0ms | 131.7ms | 606.7ms | 201.0ms | 2.6ms | 8.9 / 16.7ms | 0 | 0 | 27.2ms
GFM structure | 128 | Streamdown Word full features | 619.3ms | 154.9ms | 726.0ms | 229.4ms | 3.3ms | 17.1 / 25.0ms | 0 | 0 | 31.7ms
GFM structure | 128 | Streamdown Char full features | 1619.4ms | 243.4ms | 1775.8ms | 325.1ms | 3.5ms | 66.8 / 75.3ms | 23 | 8 | 41.9ms
GFM structure | 128 | Michi 3Hz core | 229.7ms | 39.3ms | 610.3ms | 86.7ms | 1.5ms | 9.3 / 41.8ms | 1 | 0 | 25.1ms
Code-heavy | 128 | Streamdown Word core | 5066.8ms | 445.3ms | 5205.2ms | 3560.6ms | 46.8ms | 58.6 / 67.5ms | 89 | 5 | 16.6ms
Code-heavy | 128 | Streamdown Word full features | 5397.9ms | 510.7ms | 5530.7ms | 3798.4ms | 47.9ms | 58.6 / 74.5ms | 90 | 7 | 20.1ms
Code-heavy | 128 | Streamdown Char full features | 5214.8ms | 487.6ms | 5348.2ms | 3618.2ms | 47.8ms | 58.4 / 75.1ms | 89 | 8 | 15.3ms
Code-heavy | 128 | Michi 3Hz core | 564.9ms | 113.3ms | 1751.3ms | 168.4ms | 0.8ms | 9.2 / 17.5ms | 0 | 0 | 14.9ms
Code-heavy | 128 | Michi 3Hz full features | 528.9ms | 111.9ms | 1747.5ms | 161.2ms | 0.6ms | 9.2 / 17.0ms | 0 | 0 | 17.2ms
Math + raw HTML | 128 | Streamdown Word full features | 705.3ms | 226.6ms | 819.3ms | 309.5ms | 1.8ms | 17.2 / 25.3ms | 1 | 1 | 64.3ms
Math + raw HTML | 128 | Streamdown Char full features | 946.4ms | 240.9ms | 996.6ms | 321.5ms | 1.7ms | 25.2 / 33.4ms | 4 | 1 | 67.0ms
Math + raw HTML | 128 | Michi 3Hz core | 372.8ms | 174.8ms | 733.3ms | 208.4ms | 1.7ms | 9.3 / 83.1ms | 2 | 2 | 17.8ms
Math + raw HTML | 128 | Michi 3Hz full features | 345.5ms | 183.1ms | 766.2ms | 210.6ms | 1.2ms | 9.3 / 75.0ms | 1 | 2 | 19.0ms
Math + raw HTML | 128 | Streamdown Word core | 625.3ms | 195.4ms | 767.1ms | 277.2ms | 1.4ms | 16.9 / 17.5ms | 0 | 1 | 69.8ms
Long footnotes | 128 | Streamdown Char full features | 5920.7ms | 3460.6ms | 5945.5ms | 3625.0ms | 7.9ms | 91.8 / 116.0ms | 73 | 28 | 20.2ms
Long footnotes | 128 | Michi 3Hz core | 325.3ms | 46.1ms | 958.1ms | 98.1ms | 1.0ms | 9.3 / 33.3ms | 1 | 0 | 26.7ms
Long footnotes | 128 | Michi 3Hz full features | 285.4ms | 44.4ms | 940.5ms | 93.4ms | 0.7ms | 9.2 / 24.2ms | 0 | 0 | 24.5ms
Long footnotes | 128 | Streamdown Word core | 1715.8ms | 1221.4ms | 1898.4ms | 1420.4ms | 7.5ms | 33.4 / 40.9ms | 23 | 0 | 15.6ms
Long footnotes | 128 | Streamdown Word full features | 1524.9ms | 1078.7ms | 1692.0ms | 1257.5ms | 6.7ms | 32.9 / 33.6ms | 16 | 0 | 15.5ms
Full feature parity | 128 | Michi 3Hz core | 108.5ms | 6.8ms | 508.2ms | 36.5ms | 3.2ms | 9.0 / 9.2ms | 0 | 0 | 14.1ms
Full feature parity | 128 | Michi 3Hz full features | 153.3ms | 9.0ms | 540.4ms | 38.4ms | 4.7ms | 9.1 / 9.2ms | 0 | 0 | 16.3ms
Full feature parity | 128 | Streamdown Word core | 262.4ms | 81.6ms | 448.7ms | 117.2ms | 5.1ms | 9.1 / 9.2ms | 0 | 0 | 20.4ms
Full feature parity | 128 | Streamdown Word full features | 521.9ms | 108.6ms | 1871.2ms | 118.4ms | 3.9ms | 9.2 / 16.6ms | 0 | 0 | 21.1ms
Full feature parity | 128 | Streamdown Char full features | 1367.3ms | 155.1ms | 2182.1ms | 158.2ms | 6.1ms | 25.6 / 33.2ms | 3 | 0 | 19.8ms
Prose + CJK | 512 | Michi 3Hz full features | 100.0ms | 0.7ms | 390.0ms | 48.1ms | 7.1ms | 9.0 / 9.0ms | 0 | 0 | 25.7ms
Prose + CJK | 512 | Streamdown Word core | 529.5ms | 128.3ms | 569.6ms | 204.1ms | 7.4ms | 24.2 / 25.2ms | 1 | 0 | 33.5ms
Prose + CJK | 512 | Streamdown Word full features | 515.9ms | 142.2ms | 589.5ms | 206.0ms | 8.0ms | 25.0 / 25.1ms | 1 | 1 | 34.2ms
Prose + CJK | 512 | Streamdown Char full features | 1812.3ms | 246.8ms | 1981.0ms | 298.9ms | 13.5ms | 83.4 / 91.6ms | 19 | 8 | 32.5ms
Prose + CJK | 512 | Michi 3Hz core | 115.5ms | 0.6ms | 385.8ms | 44.1ms | 4.9ms | 9.2 / 9.3ms | 0 | 0 | 23.9ms
GFM structure | 512 | Streamdown Word core | 295.1ms | 76.6ms | 378.9ms | 133.7ms | 38.3ms | 17.3 / 17.3ms | 0 | 0 | 38.3ms
GFM structure | 512 | Streamdown Word full features | 328.8ms | 87.3ms | 407.5ms | 143.8ms | 30.6ms | 25.0 / 25.0ms | 0 | 0 | 30.6ms
GFM structure | 512 | Streamdown Char full features | 801.6ms | 145.7ms | 839.1ms | 197.9ms | 34.7ms | 75.1 / 75.1ms | 8 | 3 | 34.7ms
GFM structure | 512 | Michi 3Hz core | 70.8ms | 0.3ms | 296.7ms | 38.2ms | 26.6ms | 8.7 / 8.7ms | 0 | 0 | 26.6ms
GFM structure | 512 | Michi 3Hz full features | 73.4ms | 0.4ms | 301.4ms | 39.1ms | 26.3ms | 9.0 / 9.0ms | 0 | 0 | 26.3ms
Code-heavy | 512 | Streamdown Word full features | 1628.1ms | 180.0ms | 1777.9ms | 1068.3ms | 49.3ms | 65.9 / 66.8ms | 29 | 5 | 14.9ms
Code-heavy | 512 | Streamdown Char full features | 1818.1ms | 215.3ms | 1923.4ms | 1123.9ms | 48.6ms | 66.7 / 75.3ms | 30 | 7 | 14.5ms
Code-heavy | 512 | Michi 3Hz core | 433.0ms | 72.7ms | 945.2ms | 114.8ms | 1.0ms | 9.2 / 24.9ms | 0 | 0 | 21.6ms
Code-heavy | 512 | Michi 3Hz full features | 399.6ms | 71.4ms | 909.8ms | 108.4ms | 1.1ms | 9.2 / 24.8ms | 0 | 0 | 22.4ms
Code-heavy | 512 | Streamdown Word core | 1633.5ms | 173.5ms | 1780.7ms | 1053.7ms | 49.1ms | 58.6 / 74.6ms | 29 | 4 | 12.6ms
Math + raw HTML | 512 | Streamdown Char full features | 657.1ms | 172.3ms | 681.3ms | 273.6ms | 66.2ms | 42.1 / 42.1ms | 8 | 1 | 66.2ms
Math + raw HTML | 512 | Michi 3Hz core | 162.7ms | 62.5ms | 353.4ms | 84.1ms | 14.9ms | 8.7 / 8.7ms | 0 | 0 | 14.9ms
Math + raw HTML | 512 | Michi 3Hz full features | 155.1ms | 61.4ms | 355.6ms | 83.0ms | 15.7ms | 9.2 / 9.2ms | 0 | 0 | 15.7ms
Math + raw HTML | 512 | Streamdown Word core | 402.0ms | 126.4ms | 521.2ms | 211.7ms | 68.9ms | 33.3 / 33.3ms | 3 | 1 | 68.9ms
Math + raw HTML | 512 | Streamdown Word full features | 387.3ms | 129.0ms | 500.7ms | 203.0ms | 64.4ms | 33.3 / 33.3ms | 4 | 1 | 64.4ms
Long footnotes | 512 | Michi 3Hz core | 111.4ms | 0.8ms | 392.7ms | 41.5ms | 3.8ms | 9.3 / 9.5ms | 0 | 0 | 31.4ms
Long footnotes | 512 | Michi 3Hz full features | 101.0ms | 0.8ms | 393.9ms | 41.6ms | 3.0ms | 8.8 / 9.0ms | 0 | 0 | 31.2ms
Long footnotes | 512 | Streamdown Word core | 607.8ms | 345.1ms | 712.8ms | 413.4ms | 7.6ms | 33.5 / 41.6ms | 7 | 0 | 18.4ms
Long footnotes | 512 | Streamdown Word full features | 558.7ms | 325.4ms | 657.1ms | 388.0ms | 6.1ms | 33.0 / 33.5ms | 7 | 0 | 21.1ms
Long footnotes | 512 | Streamdown Char full features | 2143.7ms | 937.3ms | 2121.3ms | 998.2ms | 11.0ms | 116.6 / 142.0ms | 18 | 15 | 25.7ms
Full feature parity | 512 | Michi 3Hz full features | 112.8ms | 7.4ms | 333.8ms | 26.3ms | 13.0ms | 9.2 / 9.2ms | 0 | 0 | 13.0ms
Full feature parity | 512 | Streamdown Word core | 134.0ms | 34.1ms | 279.4ms | 62.2ms | 15.0ms | 16.7 / 16.7ms | 0 | 0 | 15.0ms
Full feature parity | 512 | Streamdown Word full features | 418.0ms | 68.6ms | 1715.9ms | 79.8ms | 16.0ms | 17.7 / 17.7ms | 0 | 0 | 16.0ms
Full feature parity | 512 | Streamdown Char full features | 1118.7ms | 94.1ms | 1954.4ms | 102.7ms | 20.5ms | 41.9 / 41.9ms | 4 | 0 | 20.5ms
Full feature parity | 512 | Michi 3Hz core | 73.1ms | 7.3ms | 357.8ms | 30.1ms | 13.6ms | 8.6 / 8.6ms | 0 | 0 | 13.6ms

## Michi semantic snapshot lag

Fixture | chunk | Strategy | semantic snapshots | average lag | max lag
--- | ---: | --- | ---: | ---: | ---:
Prose + CJK | 128 | Michi 3Hz core | 3 | 2244.1 chars | 5120 chars
Prose + CJK | 128 | Michi 3Hz full features | 3 | 2215.4 chars | 5120 chars
GFM structure | 128 | Michi 3Hz full features | 2 | 2290.1 chars | 5120 chars
GFM structure | 128 | Michi 3Hz core | 2 | 2290.1 chars | 5120 chars
Code-heavy | 128 | Michi 3Hz core | 5 | 2423.4 chars | 5120 chars
Code-heavy | 128 | Michi 3Hz full features | 5 | 2437.9 chars | 5120 chars
Math + raw HTML | 128 | Michi 3Hz core | 2 | 2322.6 chars | 5120 chars
Math + raw HTML | 128 | Michi 3Hz full features | 2 | 2322.6 chars | 5120 chars
Long footnotes | 128 | Michi 3Hz core | 3 | 2395.0 chars | 5120 chars
Long footnotes | 128 | Michi 3Hz full features | 3 | 2443.6 chars | 5120 chars
Full feature parity | 128 | Michi 3Hz core | 1 | 1854.9 chars | 3679 chars
Full feature parity | 128 | Michi 3Hz full features | 1 | 1854.9 chars | 3679 chars
Prose + CJK | 512 | Michi 3Hz full features | 1 | 5611.8 chars | 10799 chars
Prose + CJK | 512 | Michi 3Hz core | 1 | 5611.8 chars | 10799 chars
GFM structure | 512 | Michi 3Hz core | 1 | 2804.1 chars | 5489 chars
GFM structure | 512 | Michi 3Hz full features | 1 | 2804.1 chars | 5489 chars
Code-heavy | 512 | Michi 3Hz core | 2 | 9432.5 chars | 20480 chars
Code-heavy | 512 | Michi 3Hz full features | 2 | 9432.5 chars | 20480 chars
Math + raw HTML | 512 | Michi 3Hz core | 1 | 2791.3 chars | 5336 chars
Math + raw HTML | 512 | Michi 3Hz full features | 1 | 2791.3 chars | 5336 chars
Long footnotes | 512 | Michi 3Hz core | 1 | 5369.5 chars | 10608 chars
Long footnotes | 512 | Michi 3Hz full features | 1 | 5369.5 chars | 10608 chars
Full feature parity | 512 | Michi 3Hz full features | 1 | 1755.9 chars | 3295 chars
Full feature parity | 512 | Michi 3Hz core | 1 | 1755.9 chars | 3295 chars

## Static full-document render (one new document, median)

Fixture | chars | Strategy | Task CPU | Script CPU | wall | Profiler | render call | DOM nodes
--- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---:
Prose + CJK | 11311 | Michi 3Hz core | 31.1ms | 0.0ms | 190.7ms | 24.6ms | 24.8ms | 197
Prose + CJK | 11311 | Michi 3Hz full features | 32.5ms | 0.0ms | 192.2ms | 24.9ms | 25.4ms | 225
Prose + CJK | 11311 | Streamdown Word core | 34.7ms | 0.0ms | 189.2ms | 26.8ms | 27.0ms | 225
Prose + CJK | 11311 | Streamdown Word full features | 32.9ms | 0.0ms | 191.4ms | 25.9ms | 26.4ms | 225
Prose + CJK | 11311 | Streamdown Char full features | 32.7ms | 0.0ms | 191.3ms | 25.8ms | 26.2ms | 225
GFM structure | 6001 | Michi 3Hz full features | 30.8ms | 0.0ms | 190.8ms | 24.0ms | 24.2ms | 580
GFM structure | 6001 | Streamdown Word core | 35.5ms | 0.0ms | 196.8ms | 29.1ms | 29.8ms | 540
GFM structure | 6001 | Streamdown Word full features | 37.8ms | 0.1ms | 201.0ms | 31.3ms | 31.7ms | 660
GFM structure | 6001 | Streamdown Char full features | 38.5ms | 0.0ms | 198.5ms | 31.8ms | 32.2ms | 660
GFM structure | 6001 | Michi 3Hz core | 29.4ms | 0.0ms | 186.3ms | 23.3ms | 23.7ms | 510
Code-heavy | 22542 | Streamdown Word core | 227.8ms | 40.1ms | 364.1ms | 51.5ms | 17.6ms | 6673
Code-heavy | 22542 | Streamdown Word full features | 225.3ms | 43.1ms | 371.4ms | 55.6ms | 19.3ms | 6801
Code-heavy | 22542 | Streamdown Char full features | 214.1ms | 41.7ms | 362.1ms | 53.7ms | 18.8ms | 6801
Code-heavy | 22542 | Michi 3Hz core | 205.3ms | 34.1ms | 478.3ms | 48.5ms | 17.5ms | 6753
Code-heavy | 22542 | Michi 3Hz full features | 210.3ms | 36.3ms | 392.5ms | 49.1ms | 17.5ms | 6785
Math + raw HTML | 5848 | Streamdown Word full features | 84.0ms | 0.0ms | 219.4ms | 49.5ms | 50.2ms | 3723
Math + raw HTML | 5848 | Streamdown Char full features | 70.5ms | 0.0ms | 209.5ms | 45.8ms | 46.7ms | 3723
Math + raw HTML | 5848 | Michi 3Hz core | 94.0ms | 49.7ms | 248.1ms | 62.6ms | 16.1ms | 3453
Math + raw HTML | 5848 | Michi 3Hz full features | 95.1ms | 50.7ms | 249.8ms | 63.3ms | 15.3ms | 3453
Math + raw HTML | 5848 | Streamdown Word core | 75.2ms | 0.1ms | 215.6ms | 46.7ms | 47.2ms | 3723
Long footnotes | 11120 | Streamdown Char full features | 40.4ms | 0.0ms | 196.8ms | 31.6ms | 32.0ms | 481
Long footnotes | 11120 | Michi 3Hz core | 38.3ms | 0.1ms | 195.1ms | 28.4ms | 28.8ms | 481
Long footnotes | 11120 | Michi 3Hz full features | 35.9ms | 0.0ms | 191.6ms | 27.4ms | 27.7ms | 481
Long footnotes | 11120 | Streamdown Word core | 39.9ms | 0.0ms | 195.6ms | 30.4ms | 30.8ms | 481
Long footnotes | 11120 | Streamdown Word full features | 40.8ms | 0.1ms | 197.7ms | 32.2ms | 32.5ms | 481
Full feature parity | 3807 | Michi 3Hz core | 41.8ms | 6.3ms | 283.3ms | 18.7ms | 14.0ms | 922
Full feature parity | 3807 | Michi 3Hz full features | 90.1ms | 6.3ms | 264.6ms | 18.3ms | 14.3ms | 1212
Full feature parity | 3807 | Streamdown Word core | 38.1ms | 4.5ms | 215.4ms | 18.4ms | 15.1ms | 914
Full feature parity | 3807 | Streamdown Word full features | 170.4ms | 36.6ms | 1592.7ms | 24.5ms | 15.6ms | 1418
Full feature parity | 3807 | Streamdown Char full features | 174.6ms | 36.4ms | 1558.5ms | 24.2ms | 15.9ms | 1418

## Instrumentation notes

- Core modes match the previous renderer-focused benchmark: code/math/CJK plugins enabled for Streamdown, but optional controls, line numbers, link safety, Mermaid, RTL detection, and caret disabled.
- Full modes enable CJK edge parsing, semantic strikethrough, code line numbers/download, table copy/download/fullscreen, Mermaid with controls, automatic direction, link safety, HTML indentation normalization, and a streaming caret where supported.
- Michi full features are opt-in. Production remains on the existing 3Hz core profile unless explicitly changed later.
- Streamdown Word and Char full modes have identical features; only animation segmentation differs (`sep: word` vs `sep: char`).
- Task/Script/Layout metrics come from Chrome DevTools Protocol. React Profiler time and frame intervals come from the page harness. Module loading and the first async syntax-highlighter initialization are warmed before measurement.
- Michi semantic lag counts source characters waiting for the next Markdown reinterpretation. Pending characters remain visible immediately through the lightweight tail renderer; only full Markdown semantics lag.
- Wall time includes final async highlighting and a 150ms DOM quiet window, so Task CPU and render-call latency are the cleaner measures of main-thread cost.
- Code fixtures use equal-length unique source markers for every measured document so syntax-highlighting result caches cannot make later samples artificially cheap.
