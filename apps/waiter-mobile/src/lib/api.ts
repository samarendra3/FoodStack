import { createApiClient } from '@foodstack/api-client';
import type { HealthStatus } from '@foodstack/types';
import { env } from '../env';

export const api = createApiClient({ baseUrl: env.EXPO_PUBLIC_API_URL });

export type { HealthStatus };
