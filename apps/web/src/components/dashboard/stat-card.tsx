import { Card } from '@foodstack/ui/components/card';
import type { ReactNode } from 'react';

export function StatCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon: ReactNode;
}) {
  return (
    <Card className="gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:size-4">
          {icon}
        </span>
      </div>
      <p className="text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </Card>
  );
}

export function StatCardSkeleton() {
  return (
    <Card className="gap-3" aria-hidden>
      <div className="h-4 w-24 animate-pulse rounded bg-muted" />
      <div className="h-7 w-16 animate-pulse rounded bg-muted" />
      <div className="h-3 w-32 animate-pulse rounded bg-muted" />
    </Card>
  );
}
