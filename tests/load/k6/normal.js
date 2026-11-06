// A. Normal load: restaurant traffic ramping up gradually (POS cashiers + back office).
// Defaults suit one laptop; scale with PEAK_VUS / STAGE (e.g. PEAK_VUS=200 STAGE=5m on staging).
import { THRESHOLDS, officeFlow, posFlow, prepare } from './lib/api.js';

const PEAK = Number(__ENV.PEAK_VUS || 20);
const STAGE = __ENV.STAGE || '1m';

export const options = {
  scenarios: {
    pos: {
      executor: 'ramping-vus',
      exec: 'pos',
      startVUs: 1,
      stages: [
        { duration: STAGE, target: Math.ceil(PEAK * 0.4) },
        { duration: STAGE, target: Math.ceil(PEAK * 0.8) },
        { duration: STAGE, target: Math.ceil(PEAK * 0.8) },
        { duration: '30s', target: 0 },
      ],
    },
    office: {
      executor: 'ramping-vus',
      exec: 'office',
      startVUs: 1,
      stages: [
        { duration: STAGE, target: Math.ceil(PEAK * 0.1) },
        { duration: STAGE, target: Math.ceil(PEAK * 0.2) },
        { duration: STAGE, target: Math.ceil(PEAK * 0.2) },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: THRESHOLDS,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export const setup = prepare;
export const pos = posFlow;
export const office = officeFlow;
