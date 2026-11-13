'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/components/auth/auth-provider';

export type LiveState = 'connecting' | 'live' | 'offline';

/** Reads a fetch body as Server-Sent Events until it ends or is aborted. */
async function readEvents(res: Response, onEvent: (event: string, data: string) => void) {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let cut: number;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) onEvent(event, data.join('\n'));
    }
  }
}

/**
 * Keeps one authenticated Server-Sent Events stream open (the app's single real-time channel,
 * used by the kitchen and waiter screens). Reconnects with capped, jittered exponential
 * back-off; the server also ends streams every few minutes so tokens are re-checked. Each
 * (re)connect delivers a `hello` event: callers re-fetch their data then, which is how events
 * missed while offline are recovered. `path` null keeps the stream closed.
 */
export function useLiveEvents(
  path: string | null,
  onEvent: (event: string, data: unknown) => void,
): LiveState {
  const { client } = useAuth();
  const [state, setState] = useState<LiveState>('connecting');
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  });

  useEffect(() => {
    if (!path) return;
    const abort = new AbortController();
    let attempt = 0;
    void (async () => {
      while (!abort.signal.aborted) {
        setState('connecting');
        try {
          const res = await client.stream(path, abort.signal);
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          await readEvents(res, (event, raw) => {
            if (event === 'hello') {
              attempt = 0;
              setState('live');
            }
            let data: unknown = null;
            try {
              data = JSON.parse(raw);
            } catch {
              return;
            }
            handler.current(event, data);
          });
          // The server closed the stream on schedule: reconnect straight away.
        } catch {
          if (abort.signal.aborted) return;
          setState('offline');
          attempt += 1;
        }
        if (abort.signal.aborted) return;
        const delay = attempt === 0 ? 250 : Math.min(30_000, 1_000 * 2 ** (attempt - 1));
        await new Promise((r) => setTimeout(r, delay * (0.75 + Math.random() * 0.5)));
      }
    })();
    return () => abort.abort();
  }, [client, path]);

  return path ? state : 'offline';
}
