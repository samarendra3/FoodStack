import { cn } from '../lib/utils';

export function Logo({ className, inverted = false }: { className?: string; inverted?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-semibold tracking-tight', className)}>
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
        FS
      </span>
      <span className={inverted ? 'text-white' : 'text-foreground'}>FoodStack</span>
    </span>
  );
}
