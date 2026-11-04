'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { UtensilsCrossed } from 'lucide-react';
import { useState } from 'react';
import type { Diet } from './catalog';

/** Dish photo with a neutral placeholder when the image is missing or fails to load. */
export function FoodImage({
  src,
  alt,
  className,
}: {
  src?: string;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div
        className={cn(
          'flex items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200 text-slate-400 dark:from-slate-800 dark:to-slate-900 dark:text-slate-500',
          className,
        )}
      >
        <UtensilsCrossed className="size-1/4 max-h-8 max-w-8" aria-hidden />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- menu images come from tenant uploads
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn('object-cover', className)}
    />
  );
}

export function DietMark({ diet, className }: { diet: Diet; className?: string }) {
  return (
    <span
      role="img"
      aria-label={
        diet === 'veg' ? 'Vegetarian' : diet === 'egg' ? 'Contains egg' : 'Non-vegetarian'
      }
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-[3px] border-[1.5px] bg-white',
        diet === 'veg'
          ? 'border-emerald-600 text-emerald-600'
          : diet === 'egg'
            ? 'border-amber-500 text-amber-500'
            : 'border-red-600 text-red-600',
        className,
      )}
    >
      <span className="size-2 rounded-full bg-current" />
    </span>
  );
}
