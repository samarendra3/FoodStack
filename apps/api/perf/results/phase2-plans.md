# Phase 2 query plans (measured)

Data: one restaurant, one branch, 2,00,000 orders over 30 days (3 % cancelled), PostgreSQL test database, app role under RLS, 5 runs each (median shown). Warm cache.

### F1 before — count this month's orders (ran on every order creation)

Median execution time over 5 runs: **263.166 ms**

```
Finalize Aggregate  (cost=8932.66..8932.67 rows=1 width=8) (actual time=253.131..262.217 rows=1.00 loops=1)
  Buffers: shared hit=5565
  ->  Gather  (cost=8932.44..8932.65 rows=2 width=8) (actual time=252.530..262.204 rows=3.00 loops=1)
        Workers Planned: 2
        Workers Launched: 2
        Buffers: shared hit=5565
        ->  Partial Aggregate  (cost=7932.44..7932.45 rows=1 width=8) (actual time=232.769..232.822 rows=1.00 loops=3)
              Buffers: shared hit=5565
              ->  Hash Join  (cost=8.18..7865.12 rows=26929 width=0) (actual time=0.904..232.003 rows=7938.33 loops=3)
                    Hash Cond: (o.restaurant_id = r.id)
                    Join Filter: (o.created_at >= (date_trunc('month'::text, (now() AT TIME ZONE r.timezone)) AT TIME ZONE r.timezone))
                    Rows Removed by Join Filter: 56708
                    Buffers: shared hit=5565
                    ->  Parallel Seq Scan on orders o  (cost=0.00..7640.33 rows=80786 width=24) (actual time=0.082..110.497 rows=64646.67 loops=3)
                          Filter: ((status <> 'cancelled'::text) AND (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid))
                          Rows Removed by Filter: 2020
                          Buffers: shared hit=5557
                    ->  Hash  (cost=8.17..8.17 rows=1 width=48) (actual time=0.118..0.119 rows=1.00 loops=3)
                          Buckets: 1024  Batches: 1  Memory Usage: 9kB
                          Buffers: shared hit=8
                          ->  Index Scan using restaurants_tenant_id_id_key on restaurants r  (cost=0.15..8.17 rows=1 width=48) (actual time=0.078..0.079 rows=1.00 loops=3)
                                Index Cond: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
                                Index Searches: 3
                                Buffers: shared hit=8
Planning:
  Buffers: shared hit=627
Planning Time: 14.247 ms
Execution Time: 263.166 ms
```

### F1 after — per-restaurant counter reservation with the account-wide limit (rolled back)

Median execution time over 5 runs: **0.553 ms**

```
Insert on tenant_usage_counters c  (cost=9.61..25.70 rows=1 width=48) (actual time=0.278..0.283 rows=1.00 loops=1)
  Conflict Resolution: UPDATE
  Conflict Arbiter Indexes: tenant_usage_counters_pkey
  Tuples Inserted: 0
  Conflicting Tuples: 1
  Buffers: shared hit=12
  InitPlan 1
    ->  Aggregate  (cost=9.30..9.32 rows=1 width=4) (actual time=0.074..0.075 rows=1.00 loops=1)
          Buffers: shared hit=3
          ->  Nested Loop  (cost=0.15..9.30 rows=1 width=4) (actual time=0.064..0.067 rows=1.00 loops=1)
                Join Filter: ((r_1.id = c_1.restaurant_id) AND (c_1.period = (date_trunc('month'::text, (now() AT TIME ZONE r_1.timezone)))::date))
                Rows Removed by Join Filter: 1
                Buffers: shared hit=3
                ->  Index Scan using restaurants_tenant_id_id_key on restaurants r_1  (cost=0.15..8.17 rows=1 width=64) (actual time=0.031..0.033 rows=1.00 loops=1)
                      Index Cond: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
                      Index Searches: 1
                      Buffers: shared hit=2
                ->  Seq Scan on tenant_usage_counters c_1  (cost=0.00..1.08 rows=2 width=40) (actual time=0.019..0.021 rows=2.00 loops=1)
                      Filter: ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) AND ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.platform'::text, true), ''::text) = 'on'::text)))
                      Buffers: shared hit=1
  ->  Result  (cost=0.30..16.38 rows=1 width=48) (actual time=0.125..0.127 rows=1.00 loops=1)
        One-Time Filter: (((InitPlan 1).col1 + 1) <= 1000000)
        Buffers: shared hit=7
        ->  Nested Loop  (cost=0.30..16.37 rows=1 width=48) (actual time=0.045..0.046 rows=1.00 loops=1)
              Buffers: shared hit=4
              ->  Index Scan using branches_pkey on branches b  (cost=0.15..8.18 rows=1 width=16) (actual time=0.018..0.019 rows=1.00 loops=1)
                    Index Cond: (id = '01a1a632-7aae-7d4f-bc56-94c7a332a781'::uuid)
                    Filter: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
                    Index Searches: 1
                    Buffers: shared hit=2
              ->  Index Scan using restaurants_pkey on restaurants r  (cost=0.14..8.18 rows=1 width=48) (actual time=0.025..0.025 rows=1.00 loops=1)
                    Index Cond: (id = b.restaurant_id)
                    Filter: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.928 ms
Execution Time: 0.553 ms
```

### F4 before — one-day filter converting every row

Median execution time over 5 runs: **293.833 ms**

```
Limit  (cost=9055.50..9058.41 rows=25 width=77) (actual time=287.283..293.539 rows=25.00 loops=1)
  Buffers: shared hit=5597
  ->  Gather Merge  (cost=9055.50..11931.17 rows=24691 width=77) (actual time=287.281..293.510 rows=25.00 loops=1)
        Workers Planned: 2
        Workers Launched: 2
        Buffers: shared hit=5597
        ->  Sort  (cost=8055.47..8081.19 rows=10288 width=77) (actual time=271.371..271.377 rows=24.00 loops=3)
              Sort Key: o.created_at DESC, o.id DESC
              Sort Method: top-N heapsort  Memory: 28kB
              Buffers: shared hit=5597
              Worker 0:  Sort Method: top-N heapsort  Memory: 28kB
              Worker 1:  Sort Method: top-N heapsort  Memory: 28kB
              ->  Hash Join  (cost=9.56..7765.15 rows=10288 width=77) (actual time=103.119..269.533 rows=2222.00 loops=3)
                    Hash Cond: (o.branch_id = b.id)
                    Join Filter: ((((o.created_at AT TIME ZONE b.timezone))::date >= '2026-10-25'::date) AND (((o.created_at AT TIME ZONE b.timezone))::date <= '2026-10-25'::date))
                    Rows Removed by Join Filter: 64445
                    Buffers: shared hit=5565
                    ->  Parallel Seq Scan on orders o  (cost=0.00..7536.17 rows=83333 width=61) (actual time=0.031..135.637 rows=66666.67 loops=3)
                          Filter: ((branch_id = ANY ('{01a1a632-7aae-7d4f-bc56-94c7a332a781}'::uuid[])) AND (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid))
                          Buffers: shared hit=5557
                    ->  Hash  (cost=9.53..9.53 rows=2 width=80) (actual time=0.077..0.078 rows=1.00 loops=3)
                          Buckets: 1024  Batches: 1  Memory Usage: 9kB
                          Buffers: shared hit=8
                          ->  Bitmap Heap Scan on branches b  (cost=4.17..9.53 rows=2 width=80) (actual time=0.060..0.061 rows=1.00 loops=3)
                                Recheck Cond: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
                                Heap Blocks: exact=1
                                Buffers: shared hit=8
                                ->  Bitmap Index Scan on branches_restaurant_idx  (cost=0.00..4.17 rows=2 width=0) (actual time=0.022..0.022 rows=1.00 loops=3)
                                      Index Cond: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
                                      Index Searches: 3
                                      Buffers: shared hit=5
Planning:
  Buffers: shared hit=1
Planning Time: 0.686 ms
Execution Time: 293.833 ms
```

### F4 after — one-day filter on local-day bounds

Median execution time over 5 runs: **33.939 ms**

```
Limit  (cost=1716.04..1716.10 rows=25 width=77) (actual time=31.960..31.976 rows=25.00 loops=1)
  Buffers: shared hit=243
  InitPlan 1
    ->  Aggregate  (cost=8.18..8.19 rows=1 width=8) (actual time=0.052..0.053 rows=1.00 loops=1)
          Buffers: shared hit=2
          ->  Index Scan using branches_pkey on branches tz  (cost=0.15..8.18 rows=1 width=32) (actual time=0.035..0.037 rows=1.00 loops=1)
                Index Cond: (id = ANY ('{01a1a632-7aae-7d4f-bc56-94c7a332a781}'::uuid[]))
                Filter: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
                Index Searches: 1
                Buffers: shared hit=2
  InitPlan 2
    ->  Aggregate  (cost=8.18..8.19 rows=1 width=8) (actual time=0.031..0.032 rows=1.00 loops=1)
          Buffers: shared hit=2
          ->  Index Scan using branches_pkey on branches tz_1  (cost=0.15..8.18 rows=1 width=32) (actual time=0.026..0.027 rows=1.00 loops=1)
                Index Cond: (id = ANY ('{01a1a632-7aae-7d4f-bc56-94c7a332a781}'::uuid[]))
                Filter: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
                Index Searches: 1
                Buffers: shared hit=2
  ->  Sort  (cost=1699.66..1699.96 rows=123 width=77) (actual time=31.957..31.961 rows=25.00 loops=1)
        Sort Key: o.created_at DESC, o.id DESC
        Sort Method: top-N heapsort  Memory: 28kB
        Buffers: shared hit=243
        ->  Merge Join  (cost=0.59..1696.19 rows=123 width=77) (actual time=0.204..27.735 rows=6666.00 loops=1)
              Merge Cond: (b.id = o.branch_id)
              Join Filter: ((o.created_at >= ('2026-10-25 00:00:00'::timestamp without time zone AT TIME ZONE b.timezone)) AND (o.created_at < ('2026-10-26 00:00:00'::timestamp without time zone AT TIME ZONE b.timezone)))
              Buffers: shared hit=243
              ->  Index Scan using branches_tenant_id_id_key on branches b  (cost=0.16..12.19 rows=2 width=80) (actual time=0.050..0.052 rows=1.00 loops=1)
                    Index Cond: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
                    Index Searches: 1
                    Buffers: shared hit=2
              ->  Index Scan using orders_branch_created_idx on orders o  (cost=0.43..1681.37 rows=1000 width=61) (actual time=0.141..5.724 rows=6666.00 loops=1)
                    Index Cond: ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) AND (branch_id = ANY ('{01a1a632-7aae-7d4f-bc56-94c7a332a781}'::uuid[])) AND (created_at >= (InitPlan 1).col1) AND (created_at < (InitPlan 2).col1))
                    Index Searches: 1
                    Buffers: shared hit=241
Planning:
  Buffers: shared hit=1
Planning Time: 1.831 ms
Execution Time: 33.939 ms
```

### F4 before — page total for the one-day filter

Median execution time over 5 runs: **275.307 ms**

```
Finalize Aggregate  (cost=8791.09..8791.10 rows=1 width=8) (actual time=267.959..274.962 rows=1.00 loops=1)
  Buffers: shared hit=5565
  ->  Gather  (cost=8790.87..8791.08 rows=2 width=8) (actual time=267.568..274.949 rows=3.00 loops=1)
        Workers Planned: 2
        Workers Launched: 2
        Buffers: shared hit=5565
        ->  Partial Aggregate  (cost=7790.87..7790.88 rows=1 width=8) (actual time=253.147..253.150 rows=1.00 loops=3)
              Buffers: shared hit=5565
              ->  Hash Join  (cost=9.56..7765.15 rows=10288 width=0) (actual time=111.737..252.714 rows=2222.00 loops=3)
                    Hash Cond: (o.branch_id = b.id)
                    Join Filter: ((((o.created_at AT TIME ZONE b.timezone))::date >= '2026-10-25'::date) AND (((o.created_at AT TIME ZONE b.timezone))::date <= '2026-10-25'::date))
                    Rows Removed by Join Filter: 64445
                    Buffers: shared hit=5565
                    ->  Parallel Seq Scan on orders o  (cost=0.00..7536.17 rows=83333 width=24) (actual time=0.031..124.274 rows=66666.67 loops=3)
                          Filter: ((branch_id = ANY ('{01a1a632-7aae-7d4f-bc56-94c7a332a781}'::uuid[])) AND (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid))
                          Buffers: shared hit=5557
                    ->  Hash  (cost=9.53..9.53 rows=2 width=48) (actual time=0.070..0.071 rows=1.00 loops=3)
                          Buckets: 1024  Batches: 1  Memory Usage: 9kB
                          Buffers: shared hit=8
                          ->  Bitmap Heap Scan on branches b  (cost=4.17..9.53 rows=2 width=48) (actual time=0.050..0.052 rows=1.00 loops=3)
                                Recheck Cond: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
                                Heap Blocks: exact=1
                                Buffers: shared hit=8
                                ->  Bitmap Index Scan on branches_restaurant_idx  (cost=0.00..4.17 rows=2 width=0) (actual time=0.019..0.019 rows=1.00 loops=3)
                                      Index Cond: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
                                      Index Searches: 3
                                      Buffers: shared hit=5
Planning:
  Buffers: shared hit=1
Planning Time: 0.851 ms
Execution Time: 275.307 ms
```

### F4 after — page total for the one-day filter

Median execution time over 5 runs: **10.269 ms**

```
Aggregate  (cost=93.80..93.81 rows=1 width=8) (actual time=9.827..9.833 rows=1.00 loops=1)
  Buffers: shared hit=57
  InitPlan 1
    ->  Aggregate  (cost=8.18..8.19 rows=1 width=8) (actual time=0.030..0.032 rows=1.00 loops=1)
          Buffers: shared hit=2
          ->  Index Scan using branches_pkey on branches tz  (cost=0.15..8.18 rows=1 width=32) (actual time=0.021..0.022 rows=1.00 loops=1)
                Index Cond: (id = ANY ('{01a1a632-7aae-7d4f-bc56-94c7a332a781}'::uuid[]))
                Filter: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
                Index Searches: 1
                Buffers: shared hit=2
  InitPlan 2
    ->  Aggregate  (cost=8.18..8.19 rows=1 width=8) (actual time=0.018..0.019 rows=1.00 loops=1)
          Buffers: shared hit=2
          ->  Index Scan using branches_pkey on branches tz_1  (cost=0.15..8.18 rows=1 width=32) (actual time=0.015..0.016 rows=1.00 loops=1)
                Index Cond: (id = ANY ('{01a1a632-7aae-7d4f-bc56-94c7a332a781}'::uuid[]))
                Filter: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
                Index Searches: 1
                Buffers: shared hit=2
  ->  Merge Join  (cost=9.97..77.10 rows=123 width=0) (actual time=0.136..9.195 rows=6666.00 loops=1)
        Merge Cond: (b.id = o.branch_id)
        Join Filter: ((o.created_at >= ('2026-10-25 00:00:00'::timestamp without time zone AT TIME ZONE b.timezone)) AND (o.created_at < ('2026-10-26 00:00:00'::timestamp without time zone AT TIME ZONE b.timezone)))
        Buffers: shared hit=57
        ->  Sort  (cost=9.54..9.55 rows=2 width=48) (actual time=0.038..0.041 rows=1.00 loops=1)
              Sort Key: b.id
              Sort Method: quicksort  Memory: 25kB
              Buffers: shared hit=2
              ->  Bitmap Heap Scan on branches b  (cost=4.17..9.53 rows=2 width=48) (actual time=0.026..0.027 rows=1.00 loops=1)
                    Recheck Cond: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
                    Heap Blocks: exact=1
                    Buffers: shared hit=2
                    ->  Bitmap Index Scan on branches_restaurant_idx  (cost=0.00..4.17 rows=2 width=0) (actual time=0.014..0.014 rows=1.00 loops=1)
                          Index Cond: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
                          Index Searches: 1
                          Buffers: shared hit=1
        ->  Index Only Scan using orders_branch_created_idx on orders o  (cost=0.43..64.93 rows=1000 width=24) (actual time=0.091..1.493 rows=6666.00 loops=1)
              Index Cond: ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) AND (branch_id = ANY ('{01a1a632-7aae-7d4f-bc56-94c7a332a781}'::uuid[])) AND (created_at >= (InitPlan 1).col1) AND (created_at < (InitPlan 2).col1))
              Heap Fetches: 0
              Index Searches: 1
              Buffers: shared hit=55
Planning:
  Buffers: shared hit=1
Planning Time: 0.908 ms
Execution Time: 10.269 ms
```

## Summary (median ms)

| Query                            |  Before |  After |
| -------------------------------- | ------: | -----: |
| F1 order-limit check per order   | 263.166 |  0.553 |
| F4 one-day orders page (25 rows) | 293.833 | 33.939 |
| F4 one-day page total (count)    | 275.307 | 10.269 |
