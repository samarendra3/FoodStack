// C. Soak: steady traffic for a long time to expose memory, connection and queue leaks.
// Pair with tests/load/monitor.sh (docker stats, pg connections, Redis memory, queue depth).
import { THRESHOLDS, officeFlow, posFlow, prepare } from './lib/api.js';

const VUS = Number(__ENV.VUS || 10);
const DURATION = __ENV.DURATION || '30m';

export const options = {
  scenarios: {
    pos: { executor: 'constant-vus', exec: 'pos', vus: VUS, duration: DURATION },
    office: {
      executor: 'constant-vus',
      exec: 'office',
      vus: Math.max(1, Math.ceil(VUS / 4)),
      duration: DURATION,
    },
  },
  thresholds: THRESHOLDS,
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export const setup = prepare;
export const pos = posFlow;
export const office = officeFlow;
