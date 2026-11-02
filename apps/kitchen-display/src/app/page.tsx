import { Badge } from '@foodstack/ui/components/badge';
import { Logo } from '@foodstack/ui/components/logo';
import { cn } from '@foodstack/ui/lib/utils';

const columns = [
  { key: 'new', title: 'New', accent: 'border-t-info' },
  { key: 'preparing', title: 'Preparing', accent: 'border-t-warning' },
  { key: 'ready', title: 'Ready', accent: 'border-t-success' },
] as const;

/** Kitchen display shell with status columns. Tickets arrive via Socket.IO in Phase 3. */
export default function KitchenPage() {
  return (
    <div className="dark flex h-dvh flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
        <Logo inverted />
        <Badge variant="outline">All stations</Badge>
      </header>
      <main className="grid min-h-0 flex-1 gap-3 p-3 md:grid-cols-3">
        {columns.map((column) => (
          <section
            key={column.key}
            aria-label={column.title}
            className={cn(
              'flex min-h-0 flex-col rounded-xl border border-t-4 bg-card',
              column.accent,
            )}
          >
            <div className="flex items-center justify-between p-4">
              <h2 className="text-lg font-semibold">{column.title}</h2>
              <span className="tabular rounded-md bg-muted px-2 py-0.5 text-sm">0</span>
            </div>
            <div className="flex flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
              No tickets
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}
