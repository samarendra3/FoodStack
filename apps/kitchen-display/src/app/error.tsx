'use client';

import { Button } from '@foodstack/ui/components/button';
import { EmptyState } from '@foodstack/ui/components/empty-state';

export default function Error({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <EmptyState
        title="Something went wrong"
        description="Please try again. If the problem persists, contact support."
        action={<Button onClick={reset}>Try again</Button>}
      />
    </main>
  );
}
