import { createApiClient } from '@foodstack/api-client';
import { env } from '@/env';

export const api = createApiClient({ baseUrl: env.NEXT_PUBLIC_API_URL });
