// Shared k6 helpers: config, per-VU sessions, and the restaurant traffic mix.
import { check, fail, sleep } from 'k6';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:4100').replace(/\/$/, '') + '/api/v1';
const PASSWORD = __ENV.LOAD_PASSWORD;
const OWNER = __ENV.LOAD_OWNER || 'load-owner@load.example.test';
const CASHIERS = (
  __ENV.LOAD_CASHIERS || 'load-cashier-main@load.example.test,load-cashier-second@load.example.test'
).split(',');
const TOKEN_MAX_AGE_MS = 10 * 60 * 1000; // re-login before the 15 min access-token TTL

export const ordersCreated = new Counter('orders_created');
export const rateLimited = new Counter('rate_limited_429');
export const busy503 = new Counter('analytics_busy_503');
export const orderCreateMs = new Trend('order_create_ms', true);

/**
 * Targets agreed before testing (docs/PHASE_8_FINAL_REPORT.md §2). Critical = authenticated
 * business endpoints (everything tagged critical); availability ≥ 99.9 % ⇔ error rate < 0.1 %.
 */
export const THRESHOLDS = {
  http_req_failed: ['rate<0.01'],
  'http_req_failed{critical:yes}': ['rate<0.001'],
  'http_req_duration{kind:read}': ['p(95)<300', 'p(99)<800'],
  'http_req_duration{kind:write}': ['p(95)<300', 'p(99)<800'],
  checks: ['rate>0.99'],
};

/** Each VU is its own client (own IP behind TRUST_PROXY), as real tablets and browsers are. */
function clientIp() {
  const n = __VU;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255 || 1}`;
}

const session = { token: null, at: 0, who: null };

function login(email) {
  const res = http.post(`${BASE_URL}/auth/login`, JSON.stringify({ email, password: PASSWORD }), {
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': clientIp() },
    tags: { name: 'POST /auth/login', kind: 'auth', critical: 'no' },
  });
  if (res.status === 429) rateLimited.add(1);
  if (!check(res, { 'login 200': (r) => r.status === 200 })) {
    fail(`login failed for ${email}: ${res.status} ${res.body}`);
  }
  return res.json('data.accessToken');
}

function auth(email) {
  if (!session.token || session.who !== email || Date.now() - session.at > TOKEN_MAX_AGE_MS) {
    session.token = login(email);
    session.at = Date.now();
    session.who = email;
  }
  return {
    Authorization: `Bearer ${session.token}`,
    'X-Forwarded-For': clientIp(),
    'Content-Type': 'application/json',
  };
}

function track(res) {
  if (res.status === 429) rateLimited.add(1);
  if (res.status === 503) busy503.add(1);
  return res;
}

const get = (email, path, name) =>
  track(
    http.get(`${BASE_URL}${path}`, {
      headers: auth(email),
      tags: { name, kind: 'read', critical: 'yes' },
    }),
  );

/** One-time setup: a menu to order from (idempotent), the branch ids and item ids. */
export function prepare() {
  if (!PASSWORD) fail('Set LOAD_PASSWORD (see tests/load/k6/README.md).');
  const owner = { Authorization: `Bearer ${login(OWNER)}`, 'Content-Type': 'application/json' };
  let items = http.get(`${BASE_URL}/menu/items?limit=100`, { headers: owner }).json('data') || [];
  if (items.length === 0) {
    const rows = [];
    for (let i = 1; i <= 40; i++) {
      rows.push({
        category: ['Starters', 'Mains', 'Breads', 'Drinks'][i % 4],
        name: `Load Item ${i}`,
        priceMinor: 5000 + i * 500,
        diet: i % 3 === 0 ? 'non_veg' : 'veg',
      });
    }
    const imp = http.post(`${BASE_URL}/menu/import`, JSON.stringify({ rows }), { headers: owner });
    if (imp.status >= 300) fail(`menu import failed: ${imp.status} ${imp.body}`);
    items = http.get(`${BASE_URL}/menu/items?limit=100`, { headers: owner }).json('data');
  }
  const overview = http.get(`${BASE_URL}/restaurant/overview`, { headers: owner });
  const branches = (overview.json('data.branches') || []).map((b) => b.id);
  if (branches.length === 0) fail(`no branches visible: ${overview.status} ${overview.body}`);
  return { itemIds: items.map((i) => i.id), branches };
}

/** The branch this cashier is assigned to (looked up once per VU, as the POS does). */
const branchOf = {};
function cashierBranch(email) {
  if (!branchOf[email]) {
    const res = get(email, '/restaurant/overview', 'GET /restaurant/overview');
    branchOf[email] = (res.json('data.branches') || [])[0]?.id;
    if (!branchOf[email]) fail(`no branch for ${email}: ${res.status}`);
  }
  return branchOf[email];
}

/** A cashier on the POS: place an order, read it back, list recent orders (cursor). */
export function posFlow(data) {
  const email = CASHIERS[__VU % CASHIERS.length];
  const branchId = cashierBranch(email);
  const lines = [];
  for (let i = 0; i < 1 + (__ITER % 3); i++) {
    lines.push({
      menuItemId: data.itemIds[(__VU * 7 + __ITER + i) % data.itemIds.length],
      quantity: 1 + (i % 2),
    });
  }
  const headers = { ...auth(email), 'Idempotency-Key': `k6-${__VU}-${__ITER}-${Date.now()}` };
  const res = track(
    http.post(`${BASE_URL}/orders`, JSON.stringify({ branchId, channel: 'takeaway', lines }), {
      headers,
      tags: { name: 'POST /orders', kind: 'write', critical: 'yes' },
    }),
  );
  orderCreateMs.add(res.timings.duration);
  if (check(res, { 'order created': (r) => r.status === 201 })) {
    ordersCreated.add(1);
    const id = res.json('data.id');
    check(get(email, `/orders/${id}`, 'GET /orders/:id'), {
      'order read': (r) => r.status === 200,
    });
  }
  sleep(0.5 + Math.random());
  check(
    get(email, `/orders?pagination=cursor&limit=25&branchId=${branchId}`, 'GET /orders (cursor)'),
    {
      'orders listed': (r) => r.status === 200,
    },
  );
  sleep(1 + Math.random() * 2);
}

/** An owner on the back office: dashboard, menu, payments, deep cursor paging. */
export function officeFlow() {
  check(get(OWNER, '/analytics/summary?preset=today', 'GET /analytics/summary'), {
    'summary 200': (r) => r.status === 200,
  });
  check(get(OWNER, '/menu', 'GET /menu'), { 'menu 200': (r) => r.status === 200 });
  sleep(1 + Math.random());
  let res = get(OWNER, '/orders?pagination=cursor&limit=50', 'GET /orders (cursor)');
  check(res, { 'orders 200': (r) => r.status === 200 });
  for (let i = 0; i < 3 && res.status === 200 && res.json('meta.nextCursor'); i++) {
    res = get(
      OWNER,
      `/orders?pagination=cursor&limit=50&cursor=${encodeURIComponent(res.json('meta.nextCursor'))}`,
      'GET /orders (cursor, next)',
    );
    check(res, { 'next page 200': (r) => r.status === 200 });
  }
  check(get(OWNER, '/payments?pagination=cursor&limit=25', 'GET /payments (cursor)'), {
    'payments 200': (r) => r.status === 200,
  });
  sleep(2 + Math.random() * 3);
}
