'use client';

import { motion } from 'motion/react';
import { ease, RestaurantsPanel } from '../restaurants-panel';

export default function PlatformRestaurantsPage() {
  return (
    <div className="mx-auto max-w-[90rem] space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease }}
        className="pt-2"
      >
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Restaurants</h1>
        <p className="mt-1 text-muted-foreground">
          Every restaurant on FoodStack, with its status and team size.
        </p>
      </motion.div>
      <RestaurantsPanel />
    </div>
  );
}
