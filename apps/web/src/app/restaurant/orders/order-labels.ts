import type { Order } from '@/lib/orders';

export const STATUS_STYLE: Record<Order['status'], string> = {
  open: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  completed: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  cancelled: 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300',
};
export const CHANNEL_LABEL: Record<string, string> = {
  dine_in: 'Dine-in',
  takeaway: 'Takeaway',
  delivery: 'Delivery',
  qr: 'QR',
};
