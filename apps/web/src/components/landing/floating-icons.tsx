import { cn } from '@foodstack/ui/lib/utils';
import type { LucideIcon } from 'lucide-react';
import { Float, PopIn } from './motion';

export interface FloatingIcon {
  icon: LucideIcon;
  /** Position and size classes, e.g. `top-10 left-[8%] size-10 -rotate-12`. */
  className: string;
}

/** Faint food icons drifting behind a section. Purely decorative; hidden on small screens. */
export function FloatingIcons({ icons, className }: { icons: FloatingIcon[]; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn('pointer-events-none absolute inset-0 -z-10 hidden lg:block', className)}
    >
      {icons.map(({ icon: Icon, className: position }, i) => (
        <PopIn key={i} delay={0.2 + i * 0.12} className={cn('absolute', position)}>
          <Float distance={8 + (i % 3) * 4} duration={5 + (i % 4)} delay={i * 0.4}>
            <Icon className="size-full text-primary/15" strokeWidth={1.5} />
          </Float>
        </PopIn>
      ))}
    </div>
  );
}
