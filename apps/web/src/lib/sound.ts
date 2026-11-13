'use client';

import { useEffect, useState } from 'react';

/**
 * One shared AudioContext for the app's alert sounds. Browsers start audio contexts suspended
 * until the user interacts with the page (autoplay policy), and a context created later from a
 * timer — not a click — stays silent. So the context is created/resumed on the first tap or
 * key press, and every sound plays through it.
 */
let audioCtx: AudioContext | null = null;

/** Call from a user gesture (tap / key). Safe to call repeatedly. */
export function unlockAudio(): boolean {
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return true;
  } catch {
    return false;
  }
}

export const audioReady = () => audioCtx?.state === 'running';

/** The running context, or null while the browser still blocks audio. */
export const audio = (): AudioContext | null => (audioReady() ? audioCtx : null);

/**
 * Arms audio on the first user interaction anywhere on the page and reports whether sound can
 * play, so screens can show a "tap to enable sound" prompt until it can.
 */
export function useAudioUnlock(): { ready: boolean; enable: () => void } {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const arm = () => {
      unlockAudio();
      setTimeout(() => setReady(audioReady()), 50);
    };
    window.addEventListener('pointerdown', arm);
    window.addEventListener('keydown', arm);
    return () => {
      window.removeEventListener('pointerdown', arm);
      window.removeEventListener('keydown', arm);
    };
  }, []);
  return {
    ready,
    enable: () => {
      unlockAudio();
      setTimeout(() => setReady(audioReady()), 50);
    },
  };
}
