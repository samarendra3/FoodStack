# Phase 4 cache throughput — interleaved rounds (measured)

Machine: Intel(R) Core(TM) i5-10310U CPU @ 1.70GHz, 8 logical CPUs, 8 GiB RAM. 3 rounds, order A/B then B/A alternating; each sample is a fresh app, 20 workers × 40 requests over the four cached endpoints. Run 2026-11-06T06:37:33.392Z.

|   # | Mode     | Req/s | p50 ms | p95 ms | Statements/req |
| --: | -------- | ----: | -----: | -----: | -------------: |
|   1 | database |  69.8 |  299.2 |  425.7 |           10.0 |
|   2 | cache    |  30.3 |  485.8 | 2001.1 |            7.3 |
|   3 | cache    |  85.7 |  277.2 |  348.9 |            7.3 |
|   4 | database |  61.4 |  311.6 |  505.4 |           10.0 |
|   5 | database |  40.0 |  408.8 | 1233.8 |           10.0 |
|   6 | cache    |  64.5 |  375.3 |  503.3 |            7.3 |

| Mode     | Median req/s |  Min |  Max | Median p95 ms |
| -------- | -----------: | ---: | ---: | ------------: |
| database |         61.4 | 40.0 | 69.8 |         505.4 |
| cache    |         64.5 | 30.3 | 85.7 |         503.3 |
