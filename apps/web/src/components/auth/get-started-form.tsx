'use client';

import { Button, buttonVariants } from '@foodstack/ui/components/button';
import { Label } from '@foodstack/ui/components/label';
import { cn } from '@foodstack/ui/lib/utils';
import { type AccessRequestForm, accessRequestFormSchema } from '@foodstack/validators';
import {
  ArrowLeft,
  Building2,
  CheckCircle2,
  Loader2,
  Mail,
  MapPin,
  Phone,
  Send,
  Store,
  UserRound,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import { type FormEvent, useId, useState } from 'react';
import { api } from '@/lib/api';
import { authErrorMessage } from '@/lib/auth/errors';
import { AuthHeading } from './auth-layout';
import { Field, FormAlert, fieldErrors } from './form-fields';

const EMPTY: AccessRequestForm = {
  restaurantName: '',
  contactName: '',
  email: '',
  phone: '',
  city: '',
  branchCount: '',
  message: '',
};

/** Public "Get started" request. A Super Admin reviews it and, on approval, the owner is invited. */
export function GetStartedForm() {
  const [values, setValues] = useState(EMPTY);
  const [honeypot, setHoneypot] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const messageId = useId();

  const set = (key: keyof AccessRequestForm) => (value: string) =>
    setValues((v) => ({ ...v, [key]: value }));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const parsed = accessRequestFormSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setSubmitting(true);
    const d = parsed.data;
    try {
      await api.request('/access-requests', {
        method: 'POST',
        headers: { 'X-FoodStack-CSRF': '1' },
        body: {
          restaurantName: d.restaurantName,
          contactName: d.contactName,
          email: d.email,
          phone: d.phone || undefined,
          city: d.city || undefined,
          branchCount: d.branchCount ? Number(d.branchCount) : undefined,
          message: d.message || undefined,
          website: honeypot || undefined,
          // Plan picked on the pricing page (?plan=slug); its trial length applies on approval.
          planCode: planFromUrl(),
        },
      });
      setSentTo(d.email);
    } catch (error) {
      setFormError(authErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AnimatePresence mode="wait">
      {sentTo ? (
        <motion.div
          key="done"
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          className="py-4 text-center"
        >
          <motion.span
            initial={{ scale: 0, rotate: -40 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 14, delay: 0.1 }}
            className="mx-auto flex size-16 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15"
          >
            <CheckCircle2 className="size-9" aria-hidden />
          </motion.span>
          <h1 className="mt-5 text-2xl font-bold tracking-tight text-slate-900">
            Thanks, we&apos;ve got your request!
          </h1>
          <p className="mt-2 text-slate-600">
            Our team will review it shortly. Once approved, we&apos;ll email{' '}
            <strong className="text-slate-900">{sentTo}</strong> a link to set your password and
            start your free trial.
          </p>
          <div className="mt-6 flex flex-col items-center gap-3">
            <Link
              href="/"
              className={cn(
                buttonVariants({ size: 'lg' }),
                'h-12 w-full rounded-xl sm:w-auto sm:px-8',
              )}
            >
              <ArrowLeft className="size-4" aria-hidden />
              Back to the website
            </Link>
            <Link href="/login" className="text-sm font-medium text-primary hover:underline">
              Already approved? Sign in
            </Link>
          </div>
        </motion.div>
      ) : (
        <motion.div key="form" exit={{ opacity: 0, scale: 0.98 }}>
          <AuthHeading
            title="Get started with FoodStack"
            description="Tell us about your restaurant. We'll review it and set up your free trial."
          />
          <form noValidate onSubmit={onSubmit} className="space-y-3.5">
            {formError ? <FormAlert>{formError}</FormAlert> : null}
            <div className="grid gap-3.5 sm:grid-cols-2">
              <Field
                label="Restaurant name"
                name="restaurantName"
                autoComplete="organization"
                placeholder="Spice Hub"
                icon={<Store />}
                value={values.restaurantName}
                error={errors.restaurantName}
                disabled={submitting}
                autoFocus
                onChange={(e) => set('restaurantName')(e.target.value)}
              />
              <Field
                label="Your name"
                name="contactName"
                autoComplete="name"
                placeholder="Priya Shah"
                icon={<UserRound />}
                value={values.contactName}
                error={errors.contactName}
                disabled={submitting}
                onChange={(e) => set('contactName')(e.target.value)}
              />
              <Field
                label="Work email"
                type="email"
                name="email"
                autoComplete="email"
                inputMode="email"
                placeholder="you@restaurant.com"
                icon={<Mail />}
                value={values.email}
                error={errors.email}
                disabled={submitting}
                onChange={(e) => set('email')(e.target.value)}
              />
              <Field
                label="Phone (optional)"
                type="tel"
                name="phone"
                autoComplete="tel"
                placeholder="+91 98765 43210"
                icon={<Phone />}
                value={values.phone}
                error={errors.phone}
                disabled={submitting}
                onChange={(e) => set('phone')(e.target.value)}
              />
              <Field
                label="City (optional)"
                name="city"
                autoComplete="address-level2"
                placeholder="Bhubaneswar"
                icon={<MapPin />}
                value={values.city}
                error={errors.city}
                disabled={submitting}
                onChange={(e) => set('city')(e.target.value)}
              />
              <Field
                label="Branches (optional)"
                name="branchCount"
                inputMode="numeric"
                placeholder="1"
                icon={<Building2 />}
                value={values.branchCount}
                error={errors.branchCount}
                disabled={submitting}
                onChange={(e) => set('branchCount')(e.target.value.replace(/[^\d]/g, ''))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={messageId}>Anything we should know? (optional)</Label>
              <textarea
                id={messageId}
                name="message"
                rows={2}
                maxLength={1000}
                placeholder="e.g. We need POS and kitchen display for two outlets."
                value={values.message}
                disabled={submitting}
                aria-invalid={errors.message ? true : undefined}
                onChange={(e) => set('message')(e.target.value)}
                className={cn(
                  'w-full resize-none rounded-xl border border-input bg-transparent px-3 py-2.5 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50',
                  errors.message && 'border-destructive',
                )}
              />
              {errors.message ? <p className="text-sm text-destructive">{errors.message}</p> : null}
            </div>
            {/* Honeypot: invisible to people, tempting to bots. */}
            <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
              <label>
                Website
                <input
                  tabIndex={-1}
                  autoComplete="off"
                  value={honeypot}
                  onChange={(e) => setHoneypot(e.target.value)}
                />
              </label>
            </div>
            <Button
              type="submit"
              size="lg"
              className="h-12 w-full rounded-xl text-base shadow-sm"
              disabled={submitting}
            >
              {submitting ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden />
                  Sending…
                </>
              ) : (
                <>
                  <Send className="size-4" aria-hidden />
                  Request access
                </>
              )}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-slate-700">
            Already have an account?{' '}
            <Link href="/login" className="font-medium text-primary hover:underline">
              Sign in
            </Link>
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** The plan slug from the pricing page link, if it looks valid. */
function planFromUrl(): string | undefined {
  const plan = new URLSearchParams(window.location.search).get('plan')?.toLowerCase();
  return plan && /^[a-z0-9-]{2,30}$/.test(plan) ? plan : undefined;
}
