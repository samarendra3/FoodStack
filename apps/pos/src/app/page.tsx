import { Button } from '@foodstack/ui/components/button';
import { EmptyState } from '@foodstack/ui/components/empty-state';
import { Logo } from '@foodstack/ui/components/logo';
import { CreditCard, ShoppingCart, UtensilsCrossed, Wifi } from 'lucide-react';
import { CategoryBar } from '@/components/category-bar';

/** POS shell: product area, cart and payment placeholders. No billing logic yet. */
export default function PosPage() {
  return (
    <div className="flex h-dvh flex-col bg-muted">
      <header className="flex h-14 shrink-0 items-center justify-between bg-secondary px-4 text-secondary-foreground">
        <Logo inverted />
        <div className="flex items-center gap-2 text-sm">
          <Wifi className="size-4 text-success" aria-hidden />
          <span>Online</span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="flex min-h-0 flex-1 flex-col gap-3 p-3" aria-label="Products">
          <CategoryBar />
          <EmptyState
            className="flex-1 bg-card"
            icon={<UtensilsCrossed className="size-5" />}
            title="Product grid"
            description="Menu items will appear here once the catalog module is available."
          />
        </section>

        <aside className="flex w-full shrink-0 flex-col gap-3 border-t bg-card p-3 lg:w-[400px] lg:border-t-0 lg:border-l">
          <h2 className="flex items-center gap-2 font-semibold">
            <ShoppingCart className="size-4" /> Current order
          </h2>
          <EmptyState
            className="flex-1"
            title="Cart is empty"
            description="Tap a product to add it."
          />
          <div className="space-y-3 rounded-lg border p-3" aria-label="Payment">
            <div className="flex justify-between text-sm text-muted-foreground">
              <span>Total</span>
              <span className="tabular">—</span>
            </div>
            <Button size="touch" className="w-full" disabled>
              <CreditCard /> Charge
            </Button>
          </div>
        </aside>
      </div>
    </div>
  );
}
