'use client';

import { Moon, Sun } from 'lucide-react';

export function ThemeToggle() {
  function toggle() {
    const dark = document.documentElement.classList.toggle('dark');
    try {
      localStorage.setItem('fs-theme', dark ? 'dark' : 'light');
    } catch {
      // Storage can be blocked (private mode); the toggle still works for this visit.
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle dark mode"
      className="flex size-10 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted"
    >
      <Sun className="size-5 dark:hidden" />
      <Moon className="hidden size-5 dark:block" />
    </button>
  );
}
