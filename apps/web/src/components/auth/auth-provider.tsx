'use client';

import type { AuthSession, SessionProfile } from '@foodstack/types';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { env } from '@/env';
import { AuthClient } from '@/lib/auth/auth-client';

type AuthState =
  | { status: 'loading'; profile: null }
  | { status: 'anonymous'; profile: null }
  | { status: 'authenticated'; profile: SessionProfile };

interface AuthContextValue {
  state: AuthState;
  client: AuthClient;
  /** Stores a session returned by sign-in or two-factor verification. */
  signedIn: (session: AuthSession) => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const CHANNEL = 'foodstack-auth';

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [client] = useState(() => new AuthClient(env.NEXT_PUBLIC_API_URL));
  const [state, setState] = useState<AuthState>({ status: 'loading', profile: null });

  useEffect(() => {
    const unsubscribe = client.subscribe((profile) =>
      setState(
        profile ? { status: 'authenticated', profile } : { status: 'anonymous', profile: null },
      ),
    );
    client.bootstrap();

    // Signing out in one tab signs out every tab.
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
    if (channel) {
      channel.onmessage = (event: MessageEvent) => {
        if (event.data === 'signed-out') {
          queryClient.clear();
          setState({ status: 'anonymous', profile: null });
        }
      };
    }
    return () => {
      unsubscribe();
      channel?.close();
    };
  }, [client, queryClient]);

  const signedIn = useCallback((session: AuthSession) => {
    setState({ status: 'authenticated', profile: session.profile });
  }, []);

  const signOut = useCallback(async () => {
    await client.logout().catch(() => undefined);
    queryClient.clear();
    setState({ status: 'anonymous', profile: null });
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(CHANNEL);
      channel.postMessage('signed-out');
      channel.close();
    }
  }, [client, queryClient]);

  const value = useMemo(
    () => ({ state, client, signedIn, signOut }),
    [state, client, signedIn, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

/** The signed-in profile; only for components rendered inside <RequireAuth>. */
export function useProfile(): SessionProfile {
  const { state } = useAuth();
  if (state.status !== 'authenticated') throw new Error('useProfile used outside <RequireAuth>');
  return state.profile;
}
