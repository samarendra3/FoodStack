import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE_KEY = 'foodstack:raw-response';

/** Skips the `{ data }` response envelope (e.g. file downloads, webhooks acknowledgements). */
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true);
