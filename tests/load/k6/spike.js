// B. Spike: baseline, then traffic multiplies within seconds (lunch rush / promo), then recovers.
// Recovery is judged from the per-stage latency in the summary and the error counters.
import { THRESHOLDS, officeFlow, posFlow, prepare } from './lib/api.js';

const BASE = Number(__ENV.BASE_VUS || 5);
const PEAK = Number(__ENV.PEAK_VUS || 40);

export const options = {
  scenarios: {
    pos: {
      executor: 'ramping-vus',
      exec: 'pos',
      startVUs: BASE,
      stages: [
        { duration: '1m', target: BASE },
        { duration: '10s', target: PEAK },
        { duration: '1m', target: PEAK },
        { duration: '10s', target: BASE },
        { duration: '1m', target: BASE },
      ],
    },
    office: {
      executor: 'constant-vus',
      exec: 'office',
      vus: Math.max(1, Math.ceil(BASE / 2)),
      duration: '3m30s',
    },
  },
  // A spike may breach latency targets briefly; errors must stay low throughout.
  thresholds: {
    ...THRESHOLDS,
    'http_req_duration{kind:read}': ['p(99)<2000'],
    'http_req_duration{kind:write}': ['p(99)<2000'],
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export const setup = prepare;
export const pos = posFlow;
export const office = officeFlow;
