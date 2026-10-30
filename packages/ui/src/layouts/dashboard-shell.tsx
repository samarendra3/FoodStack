import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Logo } from '../components/logo';
import { cn } from '../lib/utils';

export interface NavItem {
  label: string;
  href: string;
  icon?: ReactNode;
  active?: boolean;
}

export interface NavSection {
  title?: string;
  items: NavItem[];
}

export interface Crumb {
  label: string;
  href?: string;
}

export interface DashboardShellProps {
  nav: NavSection[];
  breadcrumbs?: Crumb[];
  headerActions?: ReactNode;
  userArea?: ReactNode;
  children: ReactNode;
}

/** Shared admin layout: dark navy sidebar, header with breadcrumbs and user area. */
export function DashboardShell({
  nav,
  breadcrumbs = [],
  headerActions,
  userArea,
  children,
}: DashboardShellProps) {
  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground lg:flex">
        <div className="flex h-16 items-center border-b border-sidebar-border px-5">
          <Logo inverted />
        </div>
        <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-5">
          {nav.map((section, index) => (
            <div key={section.title ?? index} className="space-y-1">
              {section.title ? (
                <p className="px-3 pb-1 text-xs font-medium uppercase tracking-wider text-slate-500">
                  {section.title}
                </p>
              ) : null}
              {section.items.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  aria-current={item.active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-3 rounded-md border-l-2 border-transparent px-3 py-2 text-sm transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                    item.active &&
                      'border-sidebar-primary bg-sidebar-accent text-sidebar-accent-foreground',
                  )}
                >
                  {item.icon}
                  {item.label}
                </a>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-16 items-center justify-between gap-4 border-b bg-card/90 px-4 backdrop-blur sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="lg:hidden">
              <Logo />
            </span>
            <Breadcrumbs items={breadcrumbs} />
          </div>
          <div className="flex items-center gap-3">
            {headerActions}
            {userArea}
          </div>
        </header>
        <main className="flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  if (items.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className="hidden min-w-0 sm:block">
      <ol className="flex items-center gap-1 text-sm text-muted-foreground">
        {items.map((crumb, index) => {
          const last = index === items.length - 1;
          return (
            <li key={`${crumb.label}-${index}`} className="flex items-center gap-1">
              {crumb.href && !last ? (
                <a href={crumb.href} className="hover:text-foreground">
                  {crumb.label}
                </a>
              ) : (
                <span className={cn(last && 'font-medium text-foreground')}>{crumb.label}</span>
              )}
              {!last ? <ChevronRight className="size-4" aria-hidden /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions}
    </div>
  );
}
