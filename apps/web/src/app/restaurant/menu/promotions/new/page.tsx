'use client';

import { useRouter } from 'next/navigation';
import { usePromotionMutations } from '@/lib/promotions';
import { PromotionForm } from '../promotion-form';

export default function NewPromotionPage() {
  const router = useRouter();
  const { create } = usePromotionMutations();
  return (
    <div className="mx-auto max-w-[80rem] space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">New promotion</h1>
        <p className="text-sm text-muted-foreground">
          Set the offer, where and when it applies, and an optional coupon code.
        </p>
      </div>
      <PromotionForm
        submitLabel="Create promotion"
        onCancel={() => router.push('/restaurant/menu/promotions')}
        onSubmit={async (fields) => {
          const { id } = await create.mutateAsync(fields);
          router.replace(`/restaurant/menu/promotions/${id}`);
        }}
      />
    </div>
  );
}
