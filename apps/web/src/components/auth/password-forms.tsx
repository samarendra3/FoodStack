'use client';

import { Button, buttonVariants } from '@foodstack/ui/components/button';
import {
  forgotPasswordFormSchema,
  PASSWORD_MIN_LENGTH,
  resetPasswordFormSchema,
} from '@foodstack/validators';
import { ArrowLeft, Loader2, Lock, Mail, MailCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { destinationAfterLogin } from '@/lib/auth/access';
import { authErrorMessage, errorCode } from '@/lib/auth/errors';
import { AuthHeading } from './auth-layout';
import { useAuth } from './auth-provider';
import { Field, FormAlert, fieldErrors, PasswordField } from './form-fields';

function BackToSignIn() {
  return (
    <Link
      href="/login"
      className="mt-8 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden />
      Back to sign in
    </Link>
  );
}

export function ForgotPasswordForm() {
  const { client } = useAuth();
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const parsed = forgotPasswordFormSchema.safeParse({ email });
    if (!parsed.success) {
      setFieldError(fieldErrors(parsed.error.issues).email);
      return;
    }
    setFieldError(undefined);
    setSubmitting(true);
    try {
      await client.forgotPassword(parsed.data.email);
      setSentTo(parsed.data.email);
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (sentTo) {
    return (
      <>
        <div className="mb-6 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <MailCheck className="size-6" aria-hidden />
        </div>
        <AuthHeading
          title="Check your email"
          description={
            <>
              If an account exists for <span className="font-medium text-foreground">{sentTo}</span>
              , we have sent a link to reset the password. It expires in 30 minutes.
            </>
          }
        />
        <p className="text-sm text-muted-foreground">
          No email? Check your spam folder, or{' '}
          <button
            type="button"
            className="font-medium text-primary hover:underline"
            onClick={() => setSentTo(null)}
          >
            try another address
          </button>
          .
        </p>
        <BackToSignIn />
      </>
    );
  }

  return (
    <>
      <AuthHeading
        title="Forgot your password?"
        description="Enter the email you sign in with and we will send you a reset link."
      />
      <form noValidate onSubmit={onSubmit} className="space-y-5">
        {error ? <FormAlert>{error}</FormAlert> : null}
        <Field
          label="Email"
          type="email"
          autoComplete="username"
          inputMode="email"
          placeholder="you@restaurant.com"
          icon={<Mail />}
          value={email}
          error={fieldError}
          disabled={submitting}
          autoFocus
          onChange={(e) => setEmail(e.target.value)}
        />
        <Button type="submit" size="lg" className="w-full" disabled={submitting}>
          {submitting ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {submitting ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
      <BackToSignIn />
    </>
  );
}

/** Also used for the "set your password" link that new accounts receive. */
/** Reset link from "Forgot password?". */
export function ResetPasswordForm() {
  return <SetPasswordForm welcome={false} />;
}

/** First-time link from an approval or a team invitation. */
export function WelcomePasswordForm() {
  return <SetPasswordForm welcome />;
}

/**
 * Sets the password from an emailed one-time link, then signs the person straight in and sends
 * them to their workspace. Super Admins still finish with two-step verification on sign-in.
 */
function SetPasswordForm({ welcome }: { welcome: boolean }) {
  const { client, signedIn } = useAuth();
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [values, setValues] = useState({ password: '', confirmPassword: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [invalidLink, setInvalidLink] = useState(!/^[A-Za-z0-9_-]{32,64}$/.test(token));
  const [submitting, setSubmitting] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [redirecting, setRedirecting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const parsed = resetPasswordFormSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      const result = await client.resetPassword(token, parsed.data.password);
      if (result.kind === 'session') {
        setRedirecting(true);
        signedIn(result.session);
        router.replace(destinationAfterLogin(result.session.profile, null));
        return;
      }
      setNeedsSignIn(true); // two-step verification is completed on the sign-in page
    } catch (err) {
      if (errorCode(err) === 'AUTH_RESET_TOKEN_INVALID') setInvalidLink(true);
      else setError(authErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (invalidLink) {
    return (
      <>
        <AuthHeading
          title="This link has expired"
          description={
            welcome
              ? 'Welcome links work once and expire after 72 hours. Ask for a new one below, using the email address your invitation was sent to.'
              : 'Reset links work once and expire after 30 minutes. Request a new one to continue.'
          }
        />
        <Link
          href="/forgot-password"
          className={buttonVariants({ size: 'lg', className: 'w-full' })}
        >
          {welcome ? 'Send me a new link' : 'Request a new link'}
        </Link>
        <BackToSignIn />
      </>
    );
  }

  if (redirecting) {
    return (
      <div className="flex flex-col items-center py-10 text-center" role="status">
        <Loader2 className="size-7 animate-spin text-primary" aria-hidden />
        <p className="mt-4 font-medium">
          {welcome ? 'All set! Opening your workspace…' : 'Password saved. Signing you in…'}
        </p>
      </div>
    );
  }

  if (needsSignIn) {
    return (
      <>
        <AuthHeading
          title="Password saved"
          description="Sign in with your new password to finish with two-step verification."
        />
        <Link href="/login" className={buttonVariants({ size: 'lg', className: 'w-full' })}>
          Continue to sign in
        </Link>
      </>
    );
  }

  return (
    <>
      <AuthHeading
        title={welcome ? 'Welcome to FoodStack!' : 'Choose a new password'}
        description={
          welcome
            ? 'Create a password to finish setting up your account. You will be signed in straight away.'
            : 'You will be signed in with it straight away, and signed out everywhere else.'
        }
      />
      <form noValidate onSubmit={onSubmit} className="space-y-5">
        {error ? <FormAlert>{error}</FormAlert> : null}
        <PasswordField
          label={welcome ? 'Create a password' : 'New password'}
          autoComplete="new-password"
          icon={<Lock />}
          value={values.password}
          error={errors.password}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short phrase is easy to remember.`}
          disabled={submitting}
          autoFocus
          onChange={(e) => setValues((v) => ({ ...v, password: e.target.value }))}
        />
        <PasswordField
          label="Confirm password"
          autoComplete="new-password"
          icon={<Lock />}
          value={values.confirmPassword}
          error={errors.confirmPassword}
          disabled={submitting}
          onChange={(e) => setValues((v) => ({ ...v, confirmPassword: e.target.value }))}
        />
        <Button type="submit" size="lg" className="w-full" disabled={submitting}>
          {submitting ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {submitting
            ? 'Saving…'
            : welcome
              ? 'Create password & sign in'
              : 'Save password & sign in'}
        </Button>
      </form>
      {welcome ? null : <BackToSignIn />}
    </>
  );
}
