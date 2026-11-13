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

// ---- volume ----

const VOLUME_KEY = 'foodstack.sound.volume';
const volumeListeners = new Set<(v: number) => void>();

/** Alert volume 0–1, remembered on this device (default 0.8: busy kitchens are loud). */
export function getVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    return localStorage.getItem(VOLUME_KEY) !== null && v >= 0 && v <= 1 ? v : 0.8;
  } catch {
    return 0.8;
  }
}

export function setVolume(v: number) {
  const clamped = Math.min(1, Math.max(0, v));
  try {
    localStorage.setItem(VOLUME_KEY, String(clamped));
  } catch {
    /* ignore */
  }
  volumeListeners.forEach((fn) => fn(clamped));
}

/** Current volume, kept in sync across every control on the page. */
export function useVolume(): [number, (v: number) => void] {
  const [v, setV] = useState(getVolume);
  useEffect(() => {
    volumeListeners.add(setV);
    return () => {
      volumeListeners.delete(setV);
    };
  }, []);
  return [v, setVolume];
}

// ---- original alert tones (synthesised; no audio files) ----

/** Output stage: master volume into a gentle compressor so chimes are loud but never clip. */
function output(ctx: AudioContext): AudioNode {
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 8;
  comp.ratio.value = 4;
  comp.attack.value = 0.002;
  comp.release.value = 0.2;
  const master = ctx.createGain();
  master.gain.value = getVolume();
  master.connect(comp).connect(ctx.destination);
  return master;
}

/**
 * One struck-bell note: a sine fundamental plus soft inharmonic partials (what makes it read as
 * a "chime" rather than a beep), with a 3 ms attack and an exponential ring-out.
 */
function strike(
  ctx: AudioContext,
  out: AudioNode,
  freq: number,
  at: number,
  decay: number,
  level: number,
) {
  const partials: [number, number][] = [
    [1, 1],
    [2.01, 0.32],
    [3.0, 0.14],
    [4.17, 0.06],
  ];
  for (const [ratio, amp] of partials) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq * ratio;
    // Higher partials die faster, like a real bar or bell.
    const d = decay / (1 + (ratio - 1) * 0.9);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(level * amp, at + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + d);
    osc.connect(gain).connect(out);
    osc.start(at);
    osc.stop(at + d + 0.05);
  }
}

/**
 * NEW ORDER (kitchen): an original three-note rising chime, "ding-ding-ding" —
 * E6 → G#6 → B6 (a bright major triad), quick and crisp so it cuts through kitchen noise.
 * About 1.1 s long.
 */
export function playNewOrderChime() {
  const ctx = audio();
  if (!ctx) return;
  const out = output(ctx);
  const t = ctx.currentTime + 0.02;
  strike(ctx, out, 1318.5, t, 0.55, 0.5);
  strike(ctx, out, 1661.2, t + 0.14, 0.55, 0.5);
  strike(ctx, out, 1975.5, t + 0.28, 0.9, 0.55);
}

/**
 * ORDER READY (waiter): a distinct, warmer two-tone "ding-dong" — A5 → E5 (a falling fifth),
 * longer ring-out, so waiters can tell it apart from the kitchen's new-order chime by ear.
 * About 1.6 s long.
 */
export function playReadyChime() {
  const ctx = audio();
  if (!ctx) return;
  const out = output(ctx);
  const t = ctx.currentTime + 0.02;
  strike(ctx, out, 880, t, 1.0, 0.55);
  strike(ctx, out, 659.25, t + 0.32, 1.3, 0.6);
}
