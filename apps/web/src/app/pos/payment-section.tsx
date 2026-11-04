'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { Banknote, CircleDashed, CreditCard, QrCode, Split } from 'lucide-react';

export const PAYMENT_METHODS = [
  { id: 'cash', label: 'Cash', icon: Banknote },
  { id: 'card', label: 'Card', icon: CreditCard },
  { id: 'upi', label: 'UPI', icon: QrCode },
  { id: 'split', label: 'Split', icon: Split },
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]['id'];

interface PaymentSectionProps {
  method: PaymentMethod | null;
  onMethod: (m: PaymentMethod) => void;
  disabled?: boolean;
}

export function PaymentSection({ method, onMethod, disabled }: PaymentSectionProps) {
  const selected = PAYMENT_METHODS.find((m) => m.id === method);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
          Payment
        </span>
        <span className="flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-white/10 dark:text-slate-300">
          <CircleDashed className="size-3" />
          Unpaid{selected ? ` · ${selected.label}` : ''}
        </span>
      </div>
      <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Payment method">
        {PAYMENT_METHODS.map(({ id, label, icon: Icon }) => {
          const on = method === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              onClick={() => onMethod(id)}
              className={cn(
                'flex h-14 flex-col items-center justify-center gap-1 rounded-xl border text-xs font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-50',
                on
                  ? 'border-emerald-600 bg-emerald-50 text-emerald-700 ring-2 ring-emerald-600/15 dark:bg-emerald-500/15 dark:text-emerald-300'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50 dark:border-white/10 dark:bg-transparent dark:text-slate-300',
              )}
            >
              <Icon className="size-5" />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
