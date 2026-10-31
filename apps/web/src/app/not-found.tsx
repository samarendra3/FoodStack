import { EmptyState } from '@foodstack/ui/components/empty-state';

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <EmptyState
        title="Page not found"
        description="The page you are looking for does not exist."
      />
    </main>
  );
}
