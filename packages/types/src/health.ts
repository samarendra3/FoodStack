export type HealthStatus = 'ok' | 'error' | 'shutting_down';

export interface HealthIndicatorState {
  status: string;
  [key: string]: unknown;
}

export interface HealthCheckResult {
  status: HealthStatus;
  info?: Record<string, HealthIndicatorState>;
  error?: Record<string, HealthIndicatorState>;
  details: Record<string, HealthIndicatorState>;
}
