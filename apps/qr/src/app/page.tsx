import { Button } from '@foodstack/ui/components/button';
import { Card } from '@foodstack/ui/components/card';
import { Logo } from '@foodstack/ui/components/logo';
import { MapPin, UtensilsCrossed } from 'lucide-react';

const placeholderSections = ['Recommended', 'Starters', 'Main course', 'Beverages'];

/** Customer QR landing + menu placeholder. Real table/restaurant resolution comes later. */
export default function CustomerHome() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col bg-card">
      <header className="bg-secondary px-5 pb-8 pt-6 text-secondary-foreground">
        <Logo inverted />
        <h1 className="mt-6 text-2xl font-semibold">Welcome</h1>
        <p className="mt-1 flex items-center gap-1 text-sm text-slate-300">
          <MapPin className="size-4" /> Scan the QR code on your table to view the menu
        </p>
      </header>

      <main className="-mt-4 flex-1 space-y-3 rounded-t-2xl bg-card p-5">
        <h2 className="font-semibold">Menu</h2>
        {placeholderSections.map((section) => (
          <Card key={section} className="flex-row items-center gap-3 p-4">
            <span className="flex size-10 items-center justify-center rounded-lg bg-accent text-primary">
              <UtensilsCrossed className="size-5" />
            </span>
            <div>
              <p className="font-medium">{section}</p>
              <p className="text-sm text-muted-foreground">Items coming soon</p>
            </div>
          </Card>
        ))}
      </main>

      <footer className="sticky bottom-0 border-t bg-card p-4">
        <Button size="lg" className="w-full" disabled>
          View cart
        </Button>
      </footer>
    </div>
  );
}
