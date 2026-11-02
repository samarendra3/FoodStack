'use client';

import { Button, buttonVariants } from '@foodstack/ui/components/button';
import {
  forgotPasswordFormSchema,
  PASSWORD_MIN_LENGTH,
  resetPasswordFormSchema,
} from '@foodstack/validators';
import { ArrowLeft, Loader2, Lock, Mail, MailCheck } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
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
export function ResetPasswordForm() {
  const { client } = useAuth();
  const token = useSearchParams().get('token') ?? '';
  const [values, setValues] = useState({ password: '', confirmPassword: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [invalidLink, setInvalidLink] = useState(!/^[A-Za-z0-9_-]{32,64}$/.test(token));
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

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
      await client.resetPassword(token, parsed.data.password);
      setDone(true);
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
          description="Reset links work once and expire after 30 minutes. Request a new one to continue."
        />
        <Link
          href="/forgot-password"
          className={buttonVariants({ size: 'lg', className: 'w-full' })}
        >
          Request a new link
        </Link>
        <BackToSignIn />
      </>
    );
  }

  if (done) {
    return (
      <>
        <AuthHeading
          title="Password updated"
          description="Your new password is set and you have been signed out of every other device."
        />
        <Link href="/login" className={buttonVariants({ size: 'lg', className: 'w-full' })}>
          Sign in
        </Link>
      </>
    );
  }

  return (
    <>
      <AuthHeading
        title="Choose a new password"
        description="You will use it to sign in from now on."
      />
      <form noValidate onSubmit={onSubmit} className="space-y-5">
        {error ? <FormAlert>{error}</FormAlert> : null}
        <PasswordField
          label="New password"
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
          label="Confirm new password"
          autoComplete="new-password"
          icon={<Lock />}
          value={values.confirmPassword}
          error={errors.confirmPassword}
          disabled={submitting}
          onChange={(e) => setValues((v) => ({ ...v, confirmPassword: e.target.value }))}
        />
        <Button type="submit" size="lg" className="w-full" disabled={submitting}>
          {submitting ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {submitting ? 'Saving…' : 'Set new password'}
        </Button>
      </form>
      <BackToSignIn />
    </>
  );
}
