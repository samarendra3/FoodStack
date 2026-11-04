'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { Moon, Sun } from 'lucide-react';
import { useEffect } from 'react';

/** Saved preference shared by the staff areas (restaurant, platform, POS, kitchen). */
const THEME_KEY = 'fs-app-theme';

/**
 * Light/dark switch. Applies the saved theme on mount and drops it on unmount so pages without a
 * toggle stay light. The layout's pre-paint script handles the first frame.
 */
export function ThemeToggle({ className }: { className?: string }) {
  useEffect(() => {
    try {
      if (localStorage.getItem(THEME_KEY) === 'dark')
        document.documentElement.classList.add('dark');
    } catch {
      /* storage unavailable: stay light */
    }
    return () => document.documentElement.classList.remove('dark');
  }, []);

  const toggle = () => {
    const dark = document.documentElement.classList.toggle('dark');
    try {
      localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
    } catch {
      /* not persisted */
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle dark mode"
      title="Toggle dark mode"
      className={cn(
        'flex size-9 items-center justify-center rounded-lg transition-colors',
        className,
      )}
    >
      <Moon className="size-5 dark:hidden" />
      <Sun className="hidden size-5 dark:block" />
    </button>
  );
}
