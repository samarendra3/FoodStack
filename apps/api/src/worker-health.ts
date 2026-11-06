import { readFileSync } from 'node:fs';

/**
 * Container health check for the worker: healthy while the worker touched its heartbeat file
 * within the last 30 s. `node dist/worker-health.js` (exit 0 = healthy).
 */
const file = process.env.WORKER_HEARTBEAT_FILE || '/tmp/foodstack-worker.alive';
try {
  const age = Date.now() - Number(readFileSync(file, 'utf8'));
  process.exit(age >= 0 && age < 30_000 ? 0 : 1);
} catch {
  process.exit(1);
}
