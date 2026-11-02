import { ApiError } from '@foodstack/api-client';

/**
 * User-facing message for a failed auth request. The API's own messages are written for end
 * users, so they are shown as-is; transport problems get a friendlier explanation.
 */
export function authErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const { status, detail, code } = error.problem;
    if (status === 429) return 'Too many attempts. Please wait a minute and try again.';
    if (code === 'VALIDATION_FAILED') return 'Please check the highlighted fields.';
    if (status >= 500) return 'Something went wrong on our side. Please try again shortly.';
    if (detail) return detail;
    return 'Sign-in failed. Please try again.';
  }
  return 'Cannot reach FoodStack. Check your internet connection and try again.';
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof ApiError ? error.problem.code : undefined;
}
