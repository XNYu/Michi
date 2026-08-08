# Streaming Markdown hybrid snapshot/tail comparison

Generated: 2026-08-05T14:43:51.820Z
Browser: 148.0.7778.96
Machine: darwin / arm64
Streamdown: 2.5.0; repeats: 3; each update paced by requestAnimationFrame

## Streaming summary — 128 chars/update

Strategy | Task CPU total | Script CPU total | Wall total | React render total | render call p95 worst | frame p95 worst | >25ms frames | long tasks | semantic lag avg / max
--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:
Michi 3Hz core | 1632.7ms | 339.3ms | 5489.8ms | 570.6ms | 2.9ms | 10.6ms | 4 | 1 | 2272.3 / 5120 chars
Michi 3Hz full features | 1698.4ms | 346.7ms | 5597.5ms | 577.0ms | 3.0ms | 16.6ms | 3 | 0 | 2268.9 / 5120 chars
Streamdown + Michi 3Hz snapshot/tail | 2537.6ms | 426.4ms | 7248.2ms | 798.2ms | 3.5ms | 9.3ms | 10 | 8 | 2211.4 / 5120 chars
Streamdown Word core | 8914.1ms | 1883.9ms | 10060.3ms | 5496.7ms | 46.6ms | 66.6ms | 106 | 4 | n/a
Streamdown Word full features | 9279.2ms | 1939.5ms | 11532.3ms | 5575.8ms | 46.4ms | 66.7ms | 110 | 7 | n/a
Streamdown Char full features | 15730.4ms | 4042.9ms | 17250.8ms | 7589.0ms | 46.6ms | 75.0ms | 220 | 21 | n/a

## Streaming summary — 512 chars/update

Strategy | Task CPU total | Script CPU total | Wall total | React render total | render call p95 worst | frame p95 worst | >25ms frames | long tasks | semantic lag avg / max
--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:
Michi 3Hz core | 870.2ms | 127.8ms | 2683.1ms | 303.7ms | 23.6ms | 9.2ms | 0 | 0 | 4627.5 / 20480 chars
Michi 3Hz full features | 899.6ms | 139.7ms | 2658.4ms | 316.8ms | 24.3ms | 9.3ms | 0 | 0 | 4627.5 / 20480 chars
Streamdown + Michi 3Hz snapshot/tail | 1171.8ms | 143.3ms | 3988.0ms | 411.1ms | 47.7ms | 25.0ms | 2 | 2 | 4627.5 / 20480 chars
Streamdown Word core | 3474.2ms | 787.8ms | 4198.1ms | 1928.8ms | 55.2ms | 66.8ms | 39 | 4 | n/a
Streamdown Word full features | 3769.8ms | 836.4ms | 5639.7ms | 1950.2ms | 51.7ms | 67.2ms | 37 | 8 | n/a
Streamdown Char full features | 7392.8ms | 1586.9ms | 8564.2ms | 2668.5ms | 49.7ms | 100.4ms | 82 | 20 | n/a

## Feature overhead and head-to-head CPU

Chunk | Michi full / core (feature fixture) | Streamdown Word full / core (feature fixture) | Michi full / Streamdown Word full (feature fixture) | Michi full / Streamdown Word full (all fixtures)
---: | ---: | ---: | ---: | ---:
128 chars/update | 1.69x | 2.02x | 0.33x | 0.18x
512 chars/update | 1.75x | 3.11x | 0.29x | 0.24x

## Hybrid snapshot/tail head-to-head CPU

Chunk | Hybrid / Michi full | Hybrid / Streamdown Word full | Hybrid / Streamdown Char full
---: | ---: | ---: | ---:
128 chars/update | 1.49x | 0.27x | 0.16x
512 chars/update | 1.30x | 0.31x | 0.16x

## Rendered feature audit (full feature fixture, static median)

Strategy | CJK strong | CJK delete | code actions | numbered lines | table actions | Mermaid SVGs | direction | DOM nodes
--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:
Michi 3Hz core | 0 | 0 | 9 | 0 | 0 | 0 | 0 | 922
Michi 3Hz full features | 4 | 4 | 8 | 52 | 12 | 4 | 1 | 1212
Streamdown + Michi 3Hz snapshot/tail | 4 | 4 | 14 | 53 | 12 | 4 | 1 | 1418
Streamdown Word core | 4 | 4 | 0 | 0 | 0 | 0 | 0 | 914
Streamdown Word full features | 4 | 4 | 14 | 53 | 12 | 4 | 1 | 1418
Streamdown Char full features | 4 | 4 | 14 | 53 | 12 | 4 | 1 | 1418
## Streaming detail (fixture medians)

Fixture | chunk | Strategy | Task CPU | Script CPU | wall | render total | render p95 | frame p95 / max | >25ms | long tasks | final render
--- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:
Prose + CJK | 128 | Michi 3Hz core | 276.8ms | 39.4ms | 941.4ms | 97.4ms | 0.9ms | 9.2 / 16.7ms | 0 | 0 | 20.7ms
Prose + CJK | 128 | Michi 3Hz full features | 224.9ms | 40.2ms | 947.5ms | 93.0ms | 0.9ms | 9.2 / 17.5ms | 0 | 0 | 19.6ms
Prose + CJK | 128 | Streamdown + Michi 3Hz snapshot/tail | 457.3ms | 62.9ms | 1013.2ms | 131.8ms | 1.2ms | 9.3 / 41.8ms | 2 | 0 | 23.6ms
Prose + CJK | 128 | Streamdown Word core | 670.2ms | 173.4ms | 946.3ms | 319.8ms | 3.3ms | 9.0 / 9.2ms | 0 | 0 | 30.4ms
Prose + CJK | 128 | Streamdown Word full features | 731.1ms | 183.6ms | 979.0ms | 333.7ms | 3.5ms | 9.1 / 16.7ms | 0 | 1 | 31.2ms
Prose + CJK | 128 | Streamdown Char full features | 2562.5ms | 367.9ms | 2771.3ms | 495.2ms | 3.9ms | 41.2 / 50.9ms | 32 | 1 | 32.2ms
GFM structure | 128 | Michi 3Hz full features | 171.9ms | 35.8ms | 610.4ms | 77.7ms | 0.9ms | 9.3 / 33.3ms | 1 | 0 | 22.0ms
GFM structure | 128 | Streamdown + Michi 3Hz snapshot/tail | 238.7ms | 56.4ms | 657.0ms | 113.0ms | 1.7ms | 9.3 / 66.8ms | 1 | 1 | 29.7ms
GFM structure | 128 | Streamdown Word core | 444.9ms | 137.5ms | 620.6ms | 214.0ms | 2.6ms | 9.2 / 17.5ms | 0 | 0 | 32.2ms
GFM structure | 128 | Streamdown Word full features | 546.2ms | 139.8ms | 667.8ms | 210.1ms | 2.4ms | 16.6 / 16.9ms | 0 | 0 | 28.2ms
GFM structure | 128 | Streamdown Char full features | 1288.5ms | 198.5ms | 1327.1ms | 265.5ms | 3.4ms | 50.7 / 58.3ms | 17 | 1 | 28.1ms
GFM structure | 128 | Michi 3Hz core | 170.1ms | 30.4ms | 605.7ms | 70.8ms | 0.9ms | 9.1 / 25.1ms | 1 | 0 | 22.7ms
Code-heavy | 128 | Streamdown + Michi 3Hz snapshot/tail | 889.7ms | 112.9ms | 2027.0ms | 230.7ms | 1.2ms | 9.3 / 83.0ms | 5 | 5 | 16.1ms
Code-heavy | 128 | Streamdown Word core | 5710.8ms | 419.9ms | 5873.4ms | 3543.3ms | 46.6ms | 66.6 / 83.3ms | 100 | 3 | 14.3ms
Code-heavy | 128 | Streamdown Word full features | 5739.3ms | 436.2ms | 5879.0ms | 3611.1ms | 46.4ms | 66.7 / 83.3ms | 101 | 5 | 15.8ms
Code-heavy | 128 | Streamdown Char full features | 5847.2ms | 446.6ms | 5945.8ms | 3583.6ms | 46.6ms | 66.1 / 83.1ms | 101 | 5 | 12.3ms
Code-heavy | 128 | Michi 3Hz core | 586.6ms | 96.1ms | 1837.0ms | 141.1ms | 0.6ms | 10.6 / 33.3ms | 2 | 0 | 14.6ms
Code-heavy | 128 | Michi 3Hz full features | 671.7ms | 106.4ms | 1889.6ms | 158.2ms | 0.6ms | 16.6 / 25.2ms | 1 | 0 | 15.1ms
Math + raw HTML | 128 | Streamdown Word core | 533.6ms | 159.8ms | 662.6ms | 230.8ms | 1.2ms | 16.6 / 16.9ms | 0 | 1 | 50.1ms
Math + raw HTML | 128 | Streamdown Word full features | 540.5ms | 159.8ms | 686.5ms | 224.2ms | 2.2ms | 17.0 / 17.5ms | 0 | 1 | 46.9ms
Math + raw HTML | 128 | Streamdown Char full features | 732.7ms | 195.2ms | 827.6ms | 257.9ms | 1.4ms | 17.3 / 24.8ms | 0 | 1 | 47.0ms
Math + raw HTML | 128 | Michi 3Hz core | 257.6ms | 126.6ms | 687.2ms | 150.6ms | 0.8ms | 9.1 / 50.0ms | 1 | 1 | 18.2ms
Math + raw HTML | 128 | Michi 3Hz full features | 256.2ms | 120.0ms | 699.8ms | 137.8ms | 0.8ms | 9.3 / 50.3ms | 1 | 0 | 15.5ms
Math + raw HTML | 128 | Streamdown + Michi 3Hz snapshot/tail | 345.8ms | 104.2ms | 744.7ms | 163.2ms | 1.0ms | 9.3 / 132.6ms | 1 | 2 | 45.3ms
Long footnotes | 128 | Streamdown Word full features | 1284.8ms | 926.8ms | 1481.1ms | 1088.5ms | 6.0ms | 25.1 / 33.4ms | 9 | 0 | 15.4ms
Long footnotes | 128 | Streamdown Char full features | 4355.1ms | 2718.0ms | 4368.6ms | 2870.3ms | 6.6ms | 75.0 / 100.0ms | 69 | 13 | 16.1ms
Long footnotes | 128 | Michi 3Hz core | 256.7ms | 40.9ms | 930.7ms | 83.2ms | 0.6ms | 9.0 / 25.0ms | 0 | 0 | 21.6ms
Long footnotes | 128 | Michi 3Hz full features | 229.9ms | 38.1ms | 932.1ms | 79.5ms | 0.6ms | 9.2 / 16.7ms | 0 | 0 | 26.4ms
Long footnotes | 128 | Streamdown + Michi 3Hz snapshot/tail | 390.7ms | 59.4ms | 988.4ms | 118.6ms | 1.1ms | 9.2 / 50.0ms | 1 | 0 | 27.9ms
Long footnotes | 128 | Streamdown Word core | 1338.4ms | 923.0ms | 1516.5ms | 1089.1ms | 6.1ms | 25.1 / 33.4ms | 6 | 0 | 15.6ms
Full feature parity | 128 | Streamdown Char full features | 944.3ms | 116.8ms | 2010.4ms | 116.5ms | 4.6ms | 16.8 / 25.1ms | 1 | 0 | 13.6ms
Full feature parity | 128 | Michi 3Hz core | 84.9ms | 5.8ms | 487.8ms | 27.5ms | 2.9ms | 9.2 / 9.2ms | 0 | 0 | 12.2ms
Full feature parity | 128 | Michi 3Hz full features | 143.8ms | 6.3ms | 518.1ms | 30.8ms | 3.0ms | 9.1 / 9.3ms | 0 | 0 | 14.2ms
Full feature parity | 128 | Streamdown + Michi 3Hz snapshot/tail | 215.5ms | 30.6ms | 1817.9ms | 40.9ms | 3.5ms | 9.2 / 9.3ms | 0 | 0 | 15.1ms
Full feature parity | 128 | Streamdown Word core | 216.2ms | 70.4ms | 440.9ms | 99.7ms | 3.5ms | 9.1 / 9.2ms | 0 | 0 | 12.8ms
Full feature parity | 128 | Streamdown Word full features | 437.3ms | 93.3ms | 1838.9ms | 108.2ms | 3.5ms | 9.3 / 16.1ms | 0 | 0 | 17.3ms
Prose + CJK | 512 | Michi 3Hz full features | 85.4ms | 0.5ms | 392.5ms | 41.4ms | 4.4ms | 9.0 / 9.0ms | 0 | 0 | 23.4ms
Prose + CJK | 512 | Streamdown + Michi 3Hz snapshot/tail | 110.3ms | 0.9ms | 390.0ms | 52.4ms | 6.3ms | 9.0 / 9.1ms | 0 | 0 | 23.5ms
Prose + CJK | 512 | Streamdown Word core | 417.5ms | 102.4ms | 488.5ms | 170.7ms | 6.2ms | 17.0 / 17.1ms | 0 | 0 | 28.0ms
Prose + CJK | 512 | Streamdown Word full features | 401.1ms | 99.7ms | 476.0ms | 164.3ms | 7.1ms | 16.8 / 17.0ms | 0 | 1 | 29.3ms
Prose + CJK | 512 | Streamdown Char full features | 1547.9ms | 217.5ms | 1560.9ms | 269.1ms | 12.8ms | 58.4 / 59.2ms | 18 | 3 | 30.2ms
Prose + CJK | 512 | Michi 3Hz core | 98.7ms | 0.4ms | 386.3ms | 40.5ms | 4.2ms | 8.8 / 8.8ms | 0 | 0 | 22.8ms
GFM structure | 512 | Streamdown + Michi 3Hz snapshot/tail | 76.3ms | 0.4ms | 300.4ms | 47.1ms | 29.8ms | 9.4 / 9.4ms | 0 | 0 | 29.9ms
GFM structure | 512 | Streamdown Word core | 226.1ms | 62.2ms | 332.7ms | 112.3ms | 31.7ms | 16.9 / 16.9ms | 0 | 0 | 31.7ms
GFM structure | 512 | Streamdown Word full features | 268.0ms | 71.3ms | 372.3ms | 117.8ms | 28.4ms | 24.9 / 24.9ms | 0 | 0 | 28.4ms
GFM structure | 512 | Streamdown Char full features | 646.1ms | 118.2ms | 664.6ms | 164.3ms | 27.0ms | 66.5 / 66.5ms | 7 | 3 | 27.0ms
GFM structure | 512 | Michi 3Hz core | 60.5ms | 0.3ms | 297.5ms | 34.6ms | 23.6ms | 9.1 / 9.1ms | 0 | 0 | 23.6ms
GFM structure | 512 | Michi 3Hz full features | 59.2ms | 0.3ms | 304.9ms | 35.6ms | 24.3ms | 8.9 / 8.9ms | 0 | 0 | 24.3ms
Code-heavy | 512 | Streamdown Word core | 1815.2ms | 162.0ms | 1971.5ms | 1023.1ms | 46.1ms | 66.8 / 66.9ms | 33 | 3 | 11.4ms
Code-heavy | 512 | Streamdown Word full features | 1832.2ms | 174.8ms | 1979.3ms | 1051.2ms | 50.5ms | 67.2 / 75.0ms | 31 | 6 | 12.6ms
Code-heavy | 512 | Streamdown Char full features | 1861.9ms | 170.7ms | 1985.4ms | 1029.0ms | 47.8ms | 67.1 / 75.5ms | 32 | 6 | 14.1ms
Code-heavy | 512 | Michi 3Hz core | 414.2ms | 63.2ms | 905.5ms | 90.2ms | 0.8ms | 9.2 / 17.1ms | 0 | 0 | 16.8ms
Code-heavy | 512 | Michi 3Hz full features | 418.3ms | 70.3ms | 903.7ms | 95.8ms | 0.9ms | 8.9 / 25.0ms | 0 | 0 | 17.3ms
Code-heavy | 512 | Streamdown + Michi 3Hz snapshot/tail | 531.8ms | 100.8ms | 915.3ms | 157.4ms | 2.6ms | 9.1 / 250.0ms | 2 | 1 | 18.9ms
Math + raw HTML | 512 | Streamdown Word full features | 363.9ms | 116.3ms | 479.4ms | 177.5ms | 51.7ms | 25.1 / 25.1ms | 1 | 1 | 51.7ms
Math + raw HTML | 512 | Streamdown Char full features | 512.7ms | 138.2ms | 556.6ms | 201.4ms | 49.7ms | 41.7 / 41.7ms | 5 | 1 | 49.7ms
Math + raw HTML | 512 | Michi 3Hz core | 147.2ms | 57.0ms | 355.1ms | 76.2ms | 15.4ms | 9.2 / 9.2ms | 0 | 0 | 15.4ms
Math + raw HTML | 512 | Michi 3Hz full features | 146.7ms | 61.6ms | 351.7ms | 82.0ms | 16.2ms | 9.3 / 9.3ms | 0 | 0 | 16.2ms
Math + raw HTML | 512 | Streamdown + Michi 3Hz snapshot/tail | 156.5ms | 0.7ms | 329.0ms | 70.6ms | 47.7ms | 25.0 / 25.0ms | 0 | 1 | 47.7ms
Math + raw HTML | 512 | Streamdown Word core | 352.8ms | 113.8ms | 475.2ms | 178.8ms | 55.2ms | 25.7 / 25.7ms | 1 | 1 | 55.2ms
Long footnotes | 512 | Streamdown Char full features | 1925.0ms | 864.2ms | 1909.1ms | 923.2ms | 10.3ms | 100.4 / 108.1ms | 18 | 7 | 18.8ms
Long footnotes | 512 | Michi 3Hz core | 85.9ms | 0.5ms | 380.0ms | 36.5ms | 2.8ms | 9.2 / 9.2ms | 0 | 0 | 28.3ms
Long footnotes | 512 | Michi 3Hz full features | 78.7ms | 0.6ms | 373.3ms | 35.1ms | 2.8ms | 8.9 / 9.2ms | 0 | 0 | 26.2ms
Long footnotes | 512 | Streamdown + Michi 3Hz snapshot/tail | 93.4ms | 1.0ms | 392.6ms | 45.5ms | 4.2ms | 9.1 / 9.2ms | 0 | 0 | 30.1ms
Long footnotes | 512 | Streamdown Word core | 539.0ms | 311.5ms | 658.7ms | 384.5ms | 7.9ms | 33.3 / 33.7ms | 5 | 0 | 17.7ms
Long footnotes | 512 | Streamdown Word full features | 520.6ms | 310.5ms | 639.8ms | 372.3ms | 7.5ms | 33.3 / 33.4ms | 5 | 0 | 18.8ms
Full feature parity | 512 | Michi 3Hz core | 63.7ms | 6.4ms | 358.7ms | 25.7ms | 12.5ms | 8.5 / 8.5ms | 0 | 0 | 12.5ms
Full feature parity | 512 | Michi 3Hz full features | 111.4ms | 6.3ms | 332.3ms | 26.9ms | 13.3ms | 9.2 / 9.2ms | 0 | 0 | 13.3ms
Full feature parity | 512 | Streamdown + Michi 3Hz snapshot/tail | 203.5ms | 39.4ms | 1660.7ms | 38.1ms | 15.5ms | 16.7 / 16.7ms | 0 | 0 | 15.5ms
Full feature parity | 512 | Streamdown Word core | 123.6ms | 36.0ms | 271.5ms | 59.4ms | 14.1ms | 16.7 / 16.7ms | 0 | 0 | 14.1ms
Full feature parity | 512 | Streamdown Word full features | 384.0ms | 63.7ms | 1692.9ms | 67.1ms | 16.4ms | 16.8 / 16.8ms | 0 | 0 | 16.4ms
Full feature parity | 512 | Streamdown Char full features | 899.2ms | 78.1ms | 1887.6ms | 81.5ms | 13.8ms | 33.4 / 33.4ms | 2 | 0 | 13.8ms

## Snapshot semantic lag

Fixture | chunk | Strategy | semantic snapshots | average lag | max lag
--- | ---: | --- | ---: | ---: | ---:
Prose + CJK | 128 | Michi 3Hz core | 3 | 2364.9 chars | 5120 chars
Prose + CJK | 128 | Michi 3Hz full features | 3 | 2364.9 chars | 5120 chars
Prose + CJK | 128 | Streamdown + Michi 3Hz snapshot/tail | 3 | 2248.4 chars | 5120 chars
GFM structure | 128 | Michi 3Hz full features | 2 | 2290.1 chars | 5120 chars
GFM structure | 128 | Streamdown + Michi 3Hz snapshot/tail | 2 | 2290.1 chars | 5120 chars
GFM structure | 128 | Michi 3Hz core | 2 | 2290.1 chars | 5120 chars
Code-heavy | 128 | Streamdown + Michi 3Hz snapshot/tail | 6 | 2202.8 chars | 5120 chars
Code-heavy | 128 | Michi 3Hz core | 5 | 2357.6 chars | 5120 chars
Code-heavy | 128 | Michi 3Hz full features | 5 | 2337.3 chars | 5120 chars
Math + raw HTML | 128 | Michi 3Hz core | 2 | 2322.6 chars | 5120 chars
Math + raw HTML | 128 | Michi 3Hz full features | 2 | 2322.6 chars | 5120 chars
Math + raw HTML | 128 | Streamdown + Michi 3Hz snapshot/tail | 2 | 2322.6 chars | 5120 chars
Long footnotes | 128 | Michi 3Hz core | 3 | 2443.6 chars | 5120 chars
Long footnotes | 128 | Michi 3Hz full features | 3 | 2443.6 chars | 5120 chars
Long footnotes | 128 | Streamdown + Michi 3Hz snapshot/tail | 3 | 2349.4 chars | 5120 chars
Full feature parity | 128 | Michi 3Hz core | 1 | 1854.9 chars | 3679 chars
Full feature parity | 128 | Michi 3Hz full features | 1 | 1854.9 chars | 3679 chars
Full feature parity | 128 | Streamdown + Michi 3Hz snapshot/tail | 1 | 1854.9 chars | 3679 chars
Prose + CJK | 512 | Michi 3Hz full features | 1 | 5611.8 chars | 10799 chars
Prose + CJK | 512 | Streamdown + Michi 3Hz snapshot/tail | 1 | 5611.8 chars | 10799 chars
Prose + CJK | 512 | Michi 3Hz core | 1 | 5611.8 chars | 10799 chars
GFM structure | 512 | Streamdown + Michi 3Hz snapshot/tail | 1 | 2804.1 chars | 5489 chars
GFM structure | 512 | Michi 3Hz core | 1 | 2804.1 chars | 5489 chars
GFM structure | 512 | Michi 3Hz full features | 1 | 2804.1 chars | 5489 chars
Code-heavy | 512 | Michi 3Hz core | 2 | 9432.5 chars | 20480 chars
Code-heavy | 512 | Michi 3Hz full features | 2 | 9432.5 chars | 20480 chars
Code-heavy | 512 | Streamdown + Michi 3Hz snapshot/tail | 2 | 9432.5 chars | 20480 chars
Math + raw HTML | 512 | Michi 3Hz core | 1 | 2791.3 chars | 5336 chars
Math + raw HTML | 512 | Michi 3Hz full features | 1 | 2791.3 chars | 5336 chars
Math + raw HTML | 512 | Streamdown + Michi 3Hz snapshot/tail | 1 | 2791.3 chars | 5336 chars
Long footnotes | 512 | Michi 3Hz core | 1 | 5369.5 chars | 10608 chars
Long footnotes | 512 | Michi 3Hz full features | 1 | 5369.5 chars | 10608 chars
Long footnotes | 512 | Streamdown + Michi 3Hz snapshot/tail | 1 | 5369.5 chars | 10608 chars
Full feature parity | 512 | Michi 3Hz core | 1 | 1755.9 chars | 3295 chars
Full feature parity | 512 | Michi 3Hz full features | 1 | 1755.9 chars | 3295 chars
Full feature parity | 512 | Streamdown + Michi 3Hz snapshot/tail | 1 | 1755.9 chars | 3295 chars

## Static full-document render (one new document, median)

Fixture | chars | Strategy | Task CPU | Script CPU | wall | Profiler | render call | DOM nodes
--- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---:
Prose + CJK | 11311 | Michi 3Hz core | 35.1ms | 0.1ms | 193.3ms | 25.8ms | 26.4ms | 197
Prose + CJK | 11311 | Michi 3Hz full features | 37.1ms | 0.1ms | 188.0ms | 26.5ms | 26.8ms | 225
Prose + CJK | 11311 | Streamdown + Michi 3Hz snapshot/tail | 34.5ms | 0.1ms | 192.2ms | 26.9ms | 27.0ms | 225
Prose + CJK | 11311 | Streamdown Word core | 34.9ms | 0.1ms | 192.2ms | 27.8ms | 27.9ms | 225
Prose + CJK | 11311 | Streamdown Word full features | 34.0ms | 0.1ms | 190.8ms | 27.0ms | 27.4ms | 225
Prose + CJK | 11311 | Streamdown Char full features | 34.6ms | 0.1ms | 190.6ms | 27.4ms | 27.7ms | 225
GFM structure | 6001 | Michi 3Hz full features | 34.7ms | 0.0ms | 192.7ms | 27.6ms | 28.0ms | 580
GFM structure | 6001 | Streamdown + Michi 3Hz snapshot/tail | 45.7ms | 0.1ms | 205.8ms | 36.6ms | 37.0ms | 660
GFM structure | 6001 | Streamdown Word core | 41.9ms | 0.1ms | 199.4ms | 35.8ms | 36.3ms | 540
GFM structure | 6001 | Streamdown Word full features | 42.6ms | 0.1ms | 196.9ms | 34.3ms | 34.8ms | 660
GFM structure | 6001 | Streamdown Char full features | 39.9ms | 0.1ms | 199.2ms | 32.9ms | 33.3ms | 660
GFM structure | 6001 | Michi 3Hz core | 36.8ms | 0.1ms | 196.9ms | 29.6ms | 30.0ms | 510
Code-heavy | 22542 | Streamdown + Michi 3Hz snapshot/tail | 363.5ms | 40.9ms | 513.6ms | 57.1ms | 23.5ms | 6801
Code-heavy | 22542 | Streamdown Word core | 348.7ms | 58.1ms | 480.8ms | 68.7ms | 21.7ms | 6673
Code-heavy | 22542 | Streamdown Word full features | 300.7ms | 45.0ms | 450.9ms | 63.3ms | 23.8ms | 6801
Code-heavy | 22542 | Streamdown Char full features | 334.8ms | 61.9ms | 489.3ms | 73.2ms | 23.1ms | 6801
Code-heavy | 22542 | Michi 3Hz core | 297.2ms | 37.5ms | 499.4ms | 52.0ms | 19.7ms | 6753
Code-heavy | 22542 | Michi 3Hz full features | 308.9ms | 40.9ms | 527.0ms | 57.7ms | 19.2ms | 6785
Math + raw HTML | 5848 | Streamdown Word core | 116.5ms | 0.1ms | 230.2ms | 69.7ms | 70.9ms | 3723
Math + raw HTML | 5848 | Streamdown Word full features | 77.6ms | 0.1ms | 217.3ms | 50.0ms | 51.1ms | 3723
Math + raw HTML | 5848 | Streamdown Char full features | 97.4ms | 0.1ms | 225.1ms | 61.1ms | 62.0ms | 3723
Math + raw HTML | 5848 | Michi 3Hz core | 118.5ms | 69.4ms | 259.1ms | 77.7ms | 19.0ms | 3453
Math + raw HTML | 5848 | Michi 3Hz full features | 102.8ms | 53.6ms | 254.4ms | 66.8ms | 16.6ms | 3453
Math + raw HTML | 5848 | Streamdown + Michi 3Hz snapshot/tail | 76.2ms | 0.1ms | 214.3ms | 49.5ms | 50.4ms | 3723
Long footnotes | 11120 | Streamdown Word full features | 54.9ms | 0.1ms | 213.0ms | 42.3ms | 43.0ms | 481
Long footnotes | 11120 | Streamdown Char full features | 49.8ms | 0.0ms | 210.4ms | 37.6ms | 38.5ms | 481
Long footnotes | 11120 | Michi 3Hz core | 43.6ms | 0.1ms | 201.8ms | 32.9ms | 33.4ms | 481
Long footnotes | 11120 | Michi 3Hz full features | 38.1ms | 0.1ms | 194.3ms | 28.6ms | 29.0ms | 481
Long footnotes | 11120 | Streamdown + Michi 3Hz snapshot/tail | 44.4ms | 0.1ms | 199.6ms | 34.4ms | 35.0ms | 481
Long footnotes | 11120 | Streamdown Word core | 47.0ms | 0.1ms | 202.2ms | 36.6ms | 36.9ms | 481
Full feature parity | 3807 | Streamdown Char full features | 172.8ms | 39.2ms | 1578.3ms | 26.2ms | 17.0ms | 1418
Full feature parity | 3807 | Michi 3Hz core | 44.2ms | 6.5ms | 286.1ms | 20.0ms | 15.4ms | 922
Full feature parity | 3807 | Michi 3Hz full features | 112.6ms | 7.7ms | 270.5ms | 22.4ms | 17.4ms | 1212
Full feature parity | 3807 | Streamdown + Michi 3Hz snapshot/tail | 189.0ms | 34.7ms | 1560.0ms | 26.5ms | 18.2ms | 1418
Full feature parity | 3807 | Streamdown Word core | 41.3ms | 5.7ms | 217.8ms | 20.1ms | 15.8ms | 914
Full feature parity | 3807 | Streamdown Word full features | 173.2ms | 37.7ms | 1560.1ms | 25.9ms | 17.5ms | 1418

## Instrumentation notes

- Core modes match the previous renderer-focused benchmark: code/math/CJK plugins enabled for Streamdown, but optional controls, line numbers, link safety, Mermaid, RTL detection, and caret disabled.
- Full modes enable CJK edge parsing, semantic strikethrough, code line numbers/download, table copy/download/fullscreen, Mermaid with controls, automatic direction, link safety, HTML indentation normalization, and a streaming caret where supported.
- Michi full features are opt-in. Production remains on the existing 3Hz core profile unless explicitly changed later.
- Streamdown Word and Char full modes have identical features; only animation segmentation differs (`sep: word` vs `sep: char`).
- The hybrid keeps Streamdown components/plugins but feeds them Michi-style 3Hz semantic snapshots. Pending text is rendered immediately by the lightweight Michi tail; Streamdown word animation, Shiki, Mermaid, and the unified pipeline run only when the snapshot changes.
- In an unfinished fenced code block, the hybrid tail is rendered immediately after the code block rather than inside Streamdown's code body. Injecting a React marker into the code HAST would change Streamdown's raw-code extraction; this is a known prototype visual limitation.
- Task/Script/Layout metrics come from Chrome DevTools Protocol. React Profiler time and frame intervals come from the page harness. Module loading and the first async syntax-highlighter initialization are warmed before measurement.
- Michi semantic lag counts source characters waiting for the next Markdown reinterpretation. Pending characters remain visible immediately through the lightweight tail renderer; only full Markdown semantics lag.
- Wall time includes final async highlighting and a 150ms DOM quiet window, so Task CPU and render-call latency are the cleaner measures of main-thread cost.
- Code fixtures use equal-length unique source markers for every measured document so syntax-highlighting result caches cannot make later samples artificially cheap.
