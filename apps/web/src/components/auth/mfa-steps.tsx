'use client';

import type { AuthSession, MfaEnrollment } from '@foodstack/types';
import { Button } from '@foodstack/ui/components/button';
import { recoveryCodeSchema, totpCodeSchema } from '@foodstack/validators';
import { ArrowLeft, Check, Copy, Download, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import type { AuthClient } from '@/lib/auth/auth-client';
import { authErrorMessage, errorCode } from '@/lib/auth/errors';
import { AuthHeading } from './auth-layout';
import { Field, FormAlert } from './form-fields';

/** Errors that mean the challenge is gone and the user must sign in again. */
const RESTART_CODES = new Set(['AUTH_MFA_CHALLENGE_INVALID']);

interface StepProps {
  challengeToken: string;
  client: AuthClient;
  onRestart: () => void;
}

function useCodeSubmit(onRestart: () => void) {
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [expired, setExpired] = useState(false);

  async function run(work: () => Promise<void>) {
    setError(null);
    setSubmitting(true);
    try {
      await work();
    } catch (err) {
      setError(authErrorMessage(err));
      if (RESTART_CODES.has(errorCode(err) ?? '')) setExpired(true);
      setSubmitting(false);
    }
  }
  return { error, fieldError, setFieldError, submitting, expired, run, onRestart };
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden />
      Back to sign in
    </button>
  );
}

function SubmitButton({ submitting, label }: { submitting: boolean; label: string }) {
  return (
    <Button type="submit" size="lg" className="w-full" disabled={submitting}>
      {submitting ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {submitting ? 'Verifying…' : label}
    </Button>
  );
}

const codeInputProps = {
  inputMode: 'numeric' as const,
  autoComplete: 'one-time-code',
  maxLength: 6,
  placeholder: '123456',
  className: 'text-center font-mono text-lg tracking-[0.5em]',
};

export function MfaVerifyStep({
  challengeToken,
  client,
  onDone,
  onRestart,
}: StepProps & { onDone: (session: AuthSession) => void }) {
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState('');
  const form = useCodeSubmit(onRestart);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = (useRecovery ? recoveryCodeSchema : totpCodeSchema).safeParse(value);
    if (!parsed.success) {
      form.setFieldError(parsed.error.issues[0]?.message);
      return;
    }
    form.setFieldError(undefined);
    void form.run(async () => {
      const session = await client.verifyMfa(
        useRecovery
          ? { challengeToken, recoveryCode: parsed.data }
          : { challengeToken, code: parsed.data },
      );
      onDone(session);
    });
  }

  return (
    <>
      <AuthHeading
        title="Two-step verification"
        description={
          useRecovery
            ? 'Enter one of the recovery codes you saved when you set up two-step verification.'
            : 'Enter the 6-digit code from your authenticator app.'
        }
      />
      <form noValidate onSubmit={onSubmit} className="space-y-5">
        {form.error ? <FormAlert>{form.error}</FormAlert> : null}
        {useRecovery ? (
          <Field
            label="Recovery code"
            name="recoveryCode"
            autoComplete="off"
            placeholder="XXXX-XXXX"
            className="font-mono uppercase"
            value={value}
            error={form.fieldError}
            disabled={form.submitting || form.expired}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
          />
        ) : (
          <Field
            label="Authentication code"
            name="code"
            {...codeInputProps}
            value={value}
            error={form.fieldError}
            disabled={form.submitting || form.expired}
            autoFocus
            onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))}
          />
        )}
        {form.expired ? (
          <Button size="lg" className="w-full" onClick={onRestart}>
            Sign in again
          </Button>
        ) : (
          <SubmitButton submitting={form.submitting} label="Verify and sign in" />
        )}
      </form>
      <button
        type="button"
        onClick={() => {
          setUseRecovery((v) => !v);
          setValue('');
          form.setFieldError(undefined);
        }}
        className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
      >
        <KeyRound className="size-4" aria-hidden />
        {useRecovery ? 'Use your authenticator app instead' : 'Use a recovery code instead'}
      </button>
      <div>
        <BackLink onClick={onRestart} />
      </div>
    </>
  );
}

export function MfaEnrollStep({
  challengeToken,
  client,
  onDone,
  onRestart,
}: StepProps & { onDone: (session: AuthSession, recoveryCodes: string[]) => void }) {
  const [setup, setSetup] = useState<MfaEnrollment | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const form = useCodeSubmit(onRestart);

  useEffect(() => {
    let active = true;
    client
      .startEnrollment(challengeToken)
      .then((data) => active && setSetup(data))
      .catch((error: unknown) => active && setLoadError(authErrorMessage(error)));
    return () => {
      active = false;
    };
  }, [client, challengeToken]);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = totpCodeSchema.safeParse(code);
    if (!parsed.success) {
      form.setFieldError(parsed.error.issues[0]?.message);
      return;
    }
    form.setFieldError(undefined);
    void form.run(async () => {
      const result = await client.confirmEnrollment(challengeToken, parsed.data);
      onDone(result, result.recoveryCodes);
    });
  }

  return (
    <>
      <AuthHeading
        title="Set up two-step verification"
        description="Platform administrator accounts must use an authenticator app such as Google Authenticator, Microsoft Authenticator or 1Password."
      />
      {loadError ? (
        <div className="space-y-5">
          <FormAlert>{loadError}</FormAlert>
          <Button size="lg" className="w-full" onClick={onRestart}>
            Sign in again
          </Button>
        </div>
      ) : !setup ? (
        <div className="flex items-center justify-center py-16" role="status">
          <Loader2 className="size-6 animate-spin text-primary" aria-label="Preparing setup" />
        </div>
      ) : (
        <form noValidate onSubmit={onSubmit} className="space-y-6">
          <ol className="space-y-6 text-sm">
            <li className="space-y-3">
              <p className="font-medium">1. Scan this QR code with your authenticator app</p>
              <div className="flex flex-col items-center gap-4 rounded-xl border bg-card p-4 sm:flex-row sm:items-start">
                {/* eslint-disable-next-line @next/next/no-img-element -- data URL from the API */}
                <img
                  src={setup.qrDataUrl}
                  alt="QR code for your authenticator app"
                  width={160}
                  height={160}
                  className="size-40 rounded-md bg-white p-1"
                />
                <div className="min-w-0 space-y-2 text-center sm:text-left">
                  <p className="text-muted-foreground">
                    Can&apos;t scan it? Enter this key instead:
                  </p>
                  <code className="block rounded-md bg-muted px-2 py-1.5 font-mono text-xs break-words">
                    {setup.manualKey.replace(/(.{4})/g, '$1 ').trim()}
                  </code>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                    onClick={() => {
                      void navigator.clipboard?.writeText(setup.manualKey);
                      setCopied(true);
                    }}
                  >
                    {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    {copied ? 'Copied' : 'Copy key'}
                  </button>
                </div>
              </div>
            </li>
            <li className="space-y-3">
              <p className="font-medium">2. Enter the 6-digit code it shows</p>
              {form.error ? <FormAlert>{form.error}</FormAlert> : null}
              <Field
                label="Authentication code"
                name="code"
                {...codeInputProps}
                value={code}
                error={form.fieldError}
                disabled={form.submitting || form.expired}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </li>
          </ol>
          {form.expired ? (
            <Button size="lg" className="w-full" onClick={onRestart}>
              Sign in again
            </Button>
          ) : (
            <SubmitButton submitting={form.submitting} label="Turn on two-step verification" />
          )}
        </form>
      )}
      <BackLink onClick={onRestart} />
    </>
  );
}

export function RecoveryCodesStep({
  codes,
  onContinue,
}: {
  codes: string[];
  onContinue: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');

  function download() {
    const url = URL.createObjectURL(
      new Blob([`FoodStack recovery codes\n\n${text}\n`], { type: 'text/plain' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'foodstack-recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="mb-6 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <ShieldCheck className="size-6" aria-hidden />
      </div>
      <AuthHeading
        title="Save your recovery codes"
        description="Two-step verification is on. If you lose your phone, each code below lets you sign in once. They will not be shown again."
      />
      <ul className="grid grid-cols-2 gap-2 rounded-xl border bg-muted/40 p-4 font-mono text-sm">
        {codes.map((code) => (
          <li key={code} className="rounded-md bg-card px-2 py-1.5 text-center tracking-wider">
            {code}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <Button
          variant="outline"
          className="flex-1"
          onClick={() => {
            void navigator.clipboard?.writeText(text);
            setCopied(true);
          }}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button variant="outline" className="flex-1" onClick={download}>
          <Download aria-hidden />
          Download
        </Button>
      </div>
      <label className="mt-6 flex cursor-pointer items-start gap-2.5 text-sm select-none">
        <input
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
          className="mt-0.5 size-4 accent-[var(--color-primary)]"
        />
        I have stored these codes somewhere safe
      </label>
      <Button size="lg" className="mt-6 w-full" disabled={!saved} onClick={onContinue}>
        Continue to dashboard
      </Button>
    </>
  );
}
