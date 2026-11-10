-- Phase 2: is pg_trgm worth it for FoodStack's substring searches?
-- Runs entirely inside one transaction that is ROLLED BACK: nothing persists.
-- Executed as the app role under RLS (as the API does), against foodstack_test only.
--   docker exec -i foodstack-postgres-1 psql -U foodstack_owner -d foodstack_test \
--     -v customers=200000 -v orders=300000 < apps/api/perf/phase2-trigram.sql
\set ON_ERROR_STOP on
SELECT current_database() = 'foodstack_test' AS ok \gset
\if :ok
\else
  \echo 'REFUSING: run against foodstack_test only'
  \quit
\endif
\if :{?customers}
\else
  \set customers 200000
\endif
\if :{?orders}
\else
  \set orders 300000
\endif
\timing off
BEGIN;
SET LOCAL statement_timeout = 0;
INSERT INTO tenants (slug, name) VALUES ('trgm-bench', 'trgm bench') RETURNING id AS tid \gset
INSERT INTO restaurants (tenant_id, name, slug, currency_code, country_code, timezone)
  VALUES (:'tid', 'R', 'trgm-r', 'INR', 'IN', 'Asia/Kolkata') RETURNING id AS rid \gset
INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone, is_default)
  VALUES (:'tid', :'rid', 'MAIN', 'Main', 'Asia/Kolkata', true) RETURNING id AS bid \gset

-- Realistic-ish names and Indian mobile numbers.
INSERT INTO customers (tenant_id, name, phone)
SELECT :'tid',
       (ARRAY['Aarav','Vivaan','Aditya','Diya','Ananya','Ishaan','Kavya','Rohan','Priya','Arjun'])[1 + g % 10]
         || ' ' || (ARRAY['Sharma','Verma','Iyer','Reddy','Patel','Gupta','Nair','Das','Khan','Singh'])[1 + (g / 10) % 10]
         || ' ' || g,
       '9' || lpad((g * 7919 % 1000000000)::text, 9, '0')
  FROM generate_series(1, :customers) g;
INSERT INTO orders (tenant_id, restaurant_id, branch_id, order_number, channel, status, kitchen_status,
                    customer_id, table_label, currency_code, tax_rate_bp, subtotal_minor, discount_minor,
                    tax_minor, total_minor, paid_minor, refunded_minor, created_at, completed_at)
SELECT :'tid', :'rid', :'bid', g, 'dine_in', 'completed', 'served',
       cust.ids[1 + (g * 31 % array_length(cust.ids, 1))],
       'T' || (g % 40), 'INR', 0, 1000, 0, 0, 1000, 1000, 0,
       now() - (g % 525600) * interval '1 minute', now() - (g % 525600) * interval '1 minute'
  FROM generate_series(1, :orders) g,
       (SELECT array_agg(id ORDER BY id) AS ids FROM customers WHERE tenant_id = :'tid') cust
 WHERE g % 3 = 0;  -- one order in three has a customer (the realistic case for lookups)
INSERT INTO orders (tenant_id, restaurant_id, branch_id, order_number, channel, status, kitchen_status,
                    table_label, currency_code, tax_rate_bp, subtotal_minor, discount_minor,
                    tax_minor, total_minor, paid_minor, refunded_minor, created_at, completed_at)
SELECT :'tid', :'rid', :'bid', g, 'takeaway', 'completed', 'served', NULL, 'INR', 0, 1000, 0, 0, 1000, 1000, 0,
       now() - (g % 525600) * interval '1 minute', now() - (g % 525600) * interval '1 minute'
  FROM generate_series(1, :orders) g
 WHERE g % 3 <> 0;
ANALYZE customers;
ANALYZE orders;

SET LOCAL ROLE foodstack_app;
SELECT set_config('app.tenant_id', :'tid', true);

\echo '=== customers search, no trigram index (phone digits, then a name) ==='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON)
SELECT id FROM customers c WHERE (c.phone ILIKE '%4471%' OR c.name ILIKE '%4471%') ORDER BY c.name LIMIT 25;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON)
SELECT id FROM customers c WHERE (c.phone ILIKE '%reddy 77%' OR c.name ILIKE '%reddy 77%') ORDER BY c.name LIMIT 25;
\echo '=== orders search (last 30 days), no trigram index ==='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON)
SELECT o.id FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
 WHERE o.branch_id = :'bid' AND o.created_at >= now() - interval '30 days'
   AND (o.order_number = NULL OR c.phone ILIKE '%4471%' OR c.name ILIKE '%4471%' OR o.table_label ILIKE '%4471%')
 ORDER BY o.created_at DESC, o.id DESC LIMIT 25;
\echo '=== orders search (all time), no trigram index ==='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON)
SELECT o.id FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
 WHERE o.branch_id = :'bid'
   AND (o.order_number = NULL OR c.phone ILIKE '%4471%' OR c.name ILIKE '%4471%' OR o.table_label ILIKE '%4471%')
 ORDER BY o.created_at DESC, o.id DESC LIMIT 25;

RESET ROLE;
\echo '=== building trigram indexes (customers.name, customers.phone) ==='
\timing on
CREATE INDEX trgm_customers_name ON customers USING gin (name gin_trgm_ops);
CREATE INDEX trgm_customers_phone ON customers USING gin (phone gin_trgm_ops);
\timing off
SELECT pg_size_pretty(pg_relation_size('trgm_customers_name')) AS name_idx,
       pg_size_pretty(pg_relation_size('trgm_customers_phone')) AS phone_idx,
       pg_size_pretty(pg_relation_size('customers')) AS table_size;
ANALYZE customers;
SET LOCAL ROLE foodstack_app;
SELECT set_config('app.tenant_id', :'tid', true);

\echo '=== customers search, WITH trigram indexes ==='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON)
SELECT id FROM customers c WHERE (c.phone ILIKE '%4471%' OR c.name ILIKE '%4471%') ORDER BY c.name LIMIT 25;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON)
SELECT id FROM customers c WHERE (c.phone ILIKE '%reddy 77%' OR c.name ILIKE '%reddy 77%') ORDER BY c.name LIMIT 25;
\echo '=== orders search (all time), WITH customer trigram indexes ==='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON)
SELECT o.id FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
 WHERE o.branch_id = :'bid'
   AND (o.order_number = NULL OR c.phone ILIKE '%4471%' OR c.name ILIKE '%4471%' OR o.table_label ILIKE '%4471%')
 ORDER BY o.created_at DESC, o.id DESC LIMIT 25;

RESET ROLE;
\echo '=== write cost: 10,000 customer inserts with the trigram indexes ==='
\timing on
INSERT INTO customers (tenant_id, name, phone)
SELECT :'tid', 'New Customer ' || g, '8' || lpad(g::text, 9, '0') FROM generate_series(1, 10000) g;
DROP INDEX trgm_customers_name;
DROP INDEX trgm_customers_phone;
\echo '=== same 10,000 inserts without them ==='
INSERT INTO customers (tenant_id, name, phone)
SELECT :'tid', 'Newer Customer ' || g, '7' || lpad(g::text, 9, '0') FROM generate_series(1, 10000) g;
\timing off
ROLLBACK;
\echo 'rolled back: nothing persisted'
