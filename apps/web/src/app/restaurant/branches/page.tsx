'use client';

import { Badge } from '@foodstack/ui/components/badge';
import { Building2, Clock, Coins, MapPin, Store } from 'lucide-react';
import { motion } from 'motion/react';
import { authErrorMessage } from '@/lib/auth/errors';
import { useRestaurantOverview } from '../overview';

export default function BranchesPage() {
  const overview = useRestaurantOverview();
  const data = overview.data;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Branches</h1>
        <p className="mt-1 text-sm text-[#64748B]">
          The locations you can work in. Adding and editing branches arrives with Restaurant
          Settings.
        </p>
      </div>

      {overview.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-hidden>
          {Array.from({ length: 3 }, (_, i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-xl border border-[#E2E8F0] bg-white"
            />
          ))}
        </div>
      ) : overview.isError ? (
        <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {authErrorMessage(overview.error)}
        </p>
      ) : data!.branches.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl border border-dashed border-[#E2E8F0] bg-white px-6 py-14 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-emerald-50 text-[#059669]">
            <Building2 className="size-6" />
          </span>
          <p className="mt-3 font-medium">No branches assigned to you</p>
          <p className="mt-1 text-sm text-[#64748B]">Ask an owner or admin to give you access.</p>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data!.branches.map((b, i) => {
            const restaurant = data!.restaurants.find((r) => r.id === b.restaurantId);
            return (
              <motion.li
                key={b.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: Math.min(i, 8) * 0.05 }}
                className="rounded-xl border border-[#E2E8F0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-shadow hover:shadow-[0_4px_14px_-6px_rgba(15,23,42,0.12)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-[#059669]">
                      <MapPin className="size-5" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-semibold">{b.name}</p>
                      <p className="text-xs text-[#64748B]">Code {b.code}</p>
                    </div>
                  </div>
                  <Badge variant="outline" className="shrink-0 font-normal">
                    Active
                  </Badge>
                </div>
                {restaurant ? (
                  <dl className="mt-4 space-y-2 border-t border-[#E2E8F0] pt-4 text-sm">
                    <Row icon={<Store />} label="Restaurant" value={restaurant.name} />
                    <Row icon={<Coins />} label="Currency" value={restaurant.currencyCode} />
                    <Row icon={<Clock />} label="Time zone" value={restaurant.timezone} />
                  </dl>
                ) : null}
              </motion.li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[#64748B] [&_svg]:size-4" aria-hidden>
        {icon}
      </span>
      <dt className="text-[#64748B]">{label}</dt>
      <dd className="ml-auto truncate font-medium">{value}</dd>
    </div>
  );
}
