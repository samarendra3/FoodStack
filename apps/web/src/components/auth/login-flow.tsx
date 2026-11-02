'use client';

import type { AuthSession, MfaChallenge } from '@foodstack/types';
import { Button } from '@foodstack/ui/components/button';
import { loginFormSchema } from '@foodstack/validators';
import { Info, Loader2, Lock, LogIn, Mail, ShieldCheck, Store } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { destinationAfterLogin } from '@/lib/auth/access';
import type { AuthClient } from '@/lib/auth/auth-client';
import { authErrorMessage } from '@/lib/auth/errors';
import { AuthHeading } from './auth-layout';
import { useAuth } from './auth-provider';
import { Field, FormAlert, fieldErrors, PasswordField } from './form-fields';
import { MfaEnrollStep, MfaVerifyStep, RecoveryCodesStep } from './mfa-steps';

type Step =
  | { name: 'credentials' }
  | { name: 'mfa'; challenge: MfaChallenge }
  | { name: 'recovery-codes'; codes: string[]; session: AuthSession };

/** Sign-in for every role. The API decides the destination (`homePath`) from the user's roles. */
export function LoginFlow() {
  const { state, client, signedIn } = useAuth();
  const router = useRouter();
  const next = useSearchParams().get('next');
  const [step, setStep] = useState<Step>({ name: 'credentials' });

  // Already signed in (e.g. a returning visitor): go straight to the right workspace.
  useEffect(() => {
    if (state.status === 'authenticated' && step.name === 'credentials') {
      router.replace(destinationAfterLogin(state.profile, next));
    }
  }, [state, step.name, next, router]);

  const finish = (session: AuthSession) => {
    signedIn(session);
    router.replace(destinationAfterLogin(session.profile, next));
  };

  if (step.name === 'mfa') {
    return step.challenge.mfaEnrollmentRequired ? (
      <MfaEnrollStep
        challengeToken={step.challenge.challengeToken}
        client={client}
        onDone={(session, codes) => setStep({ name: 'recovery-codes', codes, session })}
        onRestart={() => setStep({ name: 'credentials' })}
      />
    ) : (
      <MfaVerifyStep
        challengeToken={step.challenge.challengeToken}
        client={client}
        onDone={finish}
        onRestart={() => setStep({ name: 'credentials' })}
      />
    );
  }
  if (step.name === 'recovery-codes') {
    return <RecoveryCodesStep codes={step.codes} onContinue={() => finish(step.session)} />;
  }
  return (
    <CredentialsStep
      onSession={finish}
      onMfa={(challenge) => setStep({ name: 'mfa', challenge })}
      login={(input) => client.login(input)}
    />
  );
}

function CredentialsStep({
  login,
  onSession,
  onMfa,
}: {
  login: AuthClient['login'];
  onSession: (session: AuthSession) => void;
  onMfa: (challenge: MfaChallenge) => void;
}) {
  const [values, setValues] = useState({ email: '', password: '', rememberMe: false });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const parsed = loginFormSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      const result = await login(parsed.data);
      if (result.kind === 'mfa') onMfa(result.challenge);
      else onSession(result.session);
    } catch (error) {
      setFormError(authErrorMessage(error));
      setValues((v) => ({ ...v, password: '' }));
      setSubmitting(false);
    }
  }

  return (
    <>
      <AuthHeading
        title="Welcome Back!"
        description="Sign in to manage your restaurant operations"
      />
      <form
        noValidate
        onSubmit={onSubmit}
        className="space-y-3.5 [@media(min-height:860px)]:space-y-5"
      >
        {formError ? <FormAlert>{formError}</FormAlert> : null}
        <Field
          label="Email Address"
          type="email"
          name="email"
          autoComplete="username"
          inputMode="email"
          placeholder="you@restaurant.com"
          icon={<Mail />}
          value={values.email}
          error={errors.email}
          disabled={submitting}
          autoFocus
          onChange={(e) => setValues((v) => ({ ...v, email: e.target.value }))}
        />
        <PasswordField
          label="Password"
          name="password"
          autoComplete="current-password"
          placeholder="Enter your password"
          icon={<Lock />}
          value={values.password}
          error={errors.password}
          disabled={submitting}
          labelAside={
            <Link
              href="/forgot-password"
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              Forgot password?
            </Link>
          }
          onChange={(e) => setValues((v) => ({ ...v, password: e.target.value }))}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex w-fit cursor-pointer items-center gap-2.5 text-sm font-medium select-none">
            <input
              type="checkbox"
              name="rememberMe"
              checked={values.rememberMe}
              disabled={submitting}
              onChange={(e) => setValues((v) => ({ ...v, rememberMe: e.target.checked }))}
              className="size-5 rounded border-input accent-[var(--color-primary)]"
            />
            Remember me
          </label>
          <span className="hidden items-center sm:flex gap-1.5 text-sm text-slate-600">
            Keep me signed in for 30 days
            <Info className="size-4" aria-hidden />
          </span>
        </div>
        <Button
          type="submit"
          size="lg"
          className="h-12 [@media(min-height:860px)]:h-14 w-full rounded-xl text-lg shadow-lg shadow-emerald-700/20"
          disabled={submitting}
        >
          {submitting ? (
            <>
              <Loader2 className="animate-spin" aria-hidden />
              Signing in…
            </>
          ) : (
            <>
              <LogIn className="size-5" aria-hidden />
              Sign In
            </>
          )}
        </Button>
      </form>
      <div className="my-4 hidden [@media(min-height:860px)]:flex items-center gap-4 text-sm text-slate-500">
        <span className="h-px flex-1 bg-slate-200" />
        or
        <span className="h-px flex-1 bg-slate-200" />
      </div>
      {/* One form for everyone: these tiles explain who signs in here; they are not separate logins. */}
      <ul className="hidden gap-3 [@media(min-height:860px)]:grid sm:grid-cols-2">
        {ROLE_TILES.map(({ icon: Icon, title, text }) => (
          <li
            key={title}
            className="flex items-center gap-4 rounded-xl border border-slate-200 bg-slate-50/60 p-4 shadow-sm"
          >
            <Icon className="size-10 shrink-0 fill-emerald-600 text-white" aria-hidden />
            <div>
              <p className="font-semibold text-slate-900">{title}</p>
              <p className="text-xs leading-relaxed text-slate-600">{text}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 [@media(min-height:860px)]:mt-6 text-center text-sm text-slate-700">
        New to FoodStack?{' '}
        <Link
          href="/get-started"
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          Get started
        </Link>
      </p>
    </>
  );
}

const ROLE_TILES = [
  { icon: ShieldCheck, title: 'Super Admin', text: 'Manage all restaurants and platform settings' },
  { icon: Store, title: 'Restaurant Admin', text: 'Manage your restaurant and branches' },
];
