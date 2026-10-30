'use client';

import { Button } from '@foodstack/ui/components/button';
import { usePosUiStore } from '@/stores/pos-ui-store';

const placeholderCategories = ['All', 'Starters', 'Mains', 'Breads', 'Beverages', 'Desserts'];

export function CategoryBar() {
  const selected = usePosUiStore((state) => state.selectedCategory);
  const select = usePosUiStore((state) => state.selectCategory);

  return (
    <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Categories">
      {placeholderCategories.map((category) => (
        <Button
          key={category}
          role="tab"
          aria-selected={selected === category}
          size="lg"
          variant={selected === category ? 'default' : 'outline'}
          onClick={() => select(category)}
        >
          {category}
        </Button>
      ))}
    </div>
  );
}
