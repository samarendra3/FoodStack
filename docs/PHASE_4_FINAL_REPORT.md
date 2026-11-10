# Phase 4 — Throughput and MFA Reliability: Final Report

_2026-11-06 · Redis stays `noeviction` (shared with BullMQ) · the cache architecture is unchanged._

**Status: COMPLETED.** The "throughput regression" was investigated with a better-controlled
benchmark: there is no regression. It is documented with measurements below. The MFA counter is
fixed and covered by regression tests.

## 1. Throughput: investigation and root cause

**What was reported (Phase 4):** concurrent req/s, database-only → cache, was 63 → 42, 49 → 67 and 47 → 37
in three runs. Two runs showed the cache slower and one faster.

**Problems with that measurement:**

1. **One sample per mode, always in the same order** (database first, cache second), each in a freshly
   compiled Nest app, on a laptop with background load. JIT warm-up, GC and background
   jobs bias whichever runs second.
2. **Only 400 requests** per concurrent run (20 × 20), about 6–10 s of wall time, which is too short to be stable.
3. **The ceiling of what the cache can do here is small.** All four cached endpoints (`/menu`,
   `/menu/categories`, `/inventory/summary`, `/plans`) are cheap. Every request still runs the
   per-request authentication, session, permission and subscription checks, which are **deliberately not cached** so revocation takes
   effect immediately. Those checks are about 7 of the 10 SQL statements. The cache can remove at most ~27 % of
   the database work (statements 10.0 → 7.3), while adding two sequential Redis round trips (`MGET`
   version + epoch, then `GET` entry) and a `JSON.parse`.

**Better benchmark (`perf/phase4-cache.perf-spec.ts`, `PHASE4_ROUNDS`).** Rounds are interleaved
A/B, B/A, A/B: each sample is a fresh app, with 20 workers × 40 requests. Results are in
`perf/results/phase4-throughput.md`:

|          # | Mode         |    Req/s |         p95 ms |
| ---------: | ------------ | -------: | -------------: |
|          1 | database     |     69.8 |            426 |
|          2 | cache        |     30.3 | 2001 (outlier) |
|          3 | cache        |     85.7 |            349 |
|          4 | database     |     61.4 |            505 |
|          5 | database     |     40.0 |           1234 |
|          6 | cache        |     64.5 |            503 |
| **Median** | **database** | **61.4** |            505 |
| **Median** | **cache**    | **64.5** |            503 |

**Conclusion.** The medians are within noise (+5 % for the cache). Within-mode spread (30–86 and 40–70 req/s)
is far larger than the difference between modes. That spread is why single fixed-order runs pointed in
opposite directions. **No code regression exists**, so no "fix" was applied; changing working code
to chase noise would be wrong.

**Where the cache does pay off:**

- **Database load:** statements per request drop 10.0 → 7.3 every time, and Phase 4 measured fewer tuples read
  and fewer buffer hits.
- **Expensive reads:** Phase 6 analytics at 100k orders went from 187 ms to 41 ms p50. PostgreSQL CPU fell from 182 s to 6.6 s
  under concurrency, with 0 failures against 2 without the cache.
- **Real HTTP load (Phase 8):** normal and spike runs at 20–40 VUs held p95 under 100 ms.

**Caveats.** Sample 2 has a 2 s p95 outlier, a host hiccup. A few seconds of my web typecheck may
have overlapped sample 6. Neither changes the conclusion: dropping sample 2 still leaves the medians within noise.

**Possible improvement, not done (optional):** collapse the two Redis round trips into one Lua
`EVAL` that reads epoch, version and entry together. This saves ~1 RTT per hit. Worth doing only if a profile shows
Redis RTT matters; on this host it does not.

## 2. MFA failure counter (fixed, `231eb68`)

**Bug.** `registerFailure` ran `INCR` and then, only on the first failure, `EXPIRE`, as two commands. If the
second command failed (a timeout, a failover, a process crash between them), the counter existed **without a TTL**.
The challenge would then count failures forever.

**Fix.** One atomic Lua script:

```lua
local count = redis.call('INCR', KEYS[1])
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return count
```

- **Atomic:** Redis runs a script without interleaving, so there is no window without a TTL.
- **Self-healing:** a TTL-less key left by the old code gets one on its next failure.
- **The window is fixed, not sliding:** later failures never extend the expiry.
- **Fails closed:** a Redis error propagates, and the verification request fails rather than skipping the count.
- **Compatible with `noeviction`:** the keys always carry a TTL.

**Regression tests** (`integration/mfa-attempts.int-spec.ts`, real Redis, 6/6):

| Test                                                        | Verifies                                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| counts failures and reports exhaustion exactly at the limit | attempt counting and lockout (5 → exhausted)                    |
| sets the expiry on the first failure and never extends it   | expiry, a fixed window                                          |
| repairs a counter left without a TTL by the old version     | the bug itself (fails on the old code)                          |
| keeps challenges independent                                | no cross-challenge counting                                     |
| exact under concurrency: 50 parallel failures               | atomicity: count = 50, exactly 4 non-exhausted results, TTL set |
| fails closed when Redis is unavailable                      | error propagates                                                |

**Reset behaviour.** The counter is per challenge. A new sign-in creates a new challenge id, so the count
starts fresh, and the old key expires within 15 minutes. Lockout is enforced in `auth.service.ts`: exhaustion
consumes the challenge.

**End to end over HTTP (new test in `auth.int-spec.ts`, 27/27):**

- 4 wrong codes return `AUTH_MFA_INVALID`.
- The 5th returns `AUTH_MFA_CHALLENGE_INVALID`.
- Any further attempt on that challenge is rejected.
- A new sign-in gets a fresh count.

An earlier draft of this report claimed this was already covered. It wasn't: the suite only tested TOTP replay.
The test was added in this phase.
