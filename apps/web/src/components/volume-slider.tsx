'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { Volume1, Volume2, VolumeX } from 'lucide-react';
import { useRef } from 'react';
import { unlockAudio, useVolume } from '@/lib/sound';

/**
 * Alert volume for this device (shared by every screen). `onChange` previews the sound once the
 * user lets go, so they hear the level they picked.
 */
export function VolumeSlider({
  className,
  onChange,
}: {
  className?: string;
  onChange?: (v: number) => void;
}) {
  const [volume, setVolume] = useVolume();
  const preview = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const Icon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  return (
    <label className={cn('flex items-center gap-2 text-slate-500', className)}>
      <Icon className="size-4 shrink-0" aria-hidden />
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={Math.round(volume * 100)}
        aria-label="Alert volume"
        onChange={(e) => {
          const v = Number(e.target.value) / 100;
          setVolume(v);
          unlockAudio();
          clearTimeout(preview.current);
          preview.current = setTimeout(() => onChange?.(v), 250);
        }}
        className="h-1.5 w-full cursor-pointer accent-emerald-600"
      />
    </label>
  );
}
