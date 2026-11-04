import {
  addCycle,
  alertLevel,
  canTransition,
  effectiveStatus,
  hasAccess,
  remainingDays,
  SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
  subscriptionState,
  trialReminder,
} from './subscription-state';

const now = new Date('2026-11-03T10:00:00Z');
const days = (n: number) => new Date(now.getTime() + n * 86_400_000);
const sub = (status: SubscriptionStatus, end: number | null, length = 30) => ({
  status,
  periodStart: days((end ?? 0) - length),
  periodEnd: end === null ? null : days(end),
});

describe('subscription state', () => {
  it('never returns negative remaining days', () => {
    expect(remainingDays(now, days(-40))).toBe(0);
    expect(remainingDays(now, days(0.2))).toBe(1);
    expect(remainingDays(now, days(30))).toBe(30);
  });

  it('maps remaining days to alert levels', () => {
    expect(alertLevel(16, false)).toBe('none');
    expect(alertLevel(15, false)).toBe('soon');
    expect(alertLevel(6, false)).toBe('urgent');
    expect(alertLevel(0, true)).toBe('expired');
  });

  describe('trial expiry', () => {
    it('keeps a running trial and expires it at the exact end instant (UTC)', () => {
      expect(effectiveStatus(sub('trialing', 10, 15), now)).toBe('trialing');
      const end = new Date('2026-11-18T00:00:00Z');
      const trial = { status: 'trialing' as const, periodStart: days(-15), periodEnd: end };
      expect(effectiveStatus(trial, new Date(end.getTime() - 1))).toBe('trialing');
      expect(effectiveStatus(trial, end)).toBe('expired');
    });

    it('is idempotent', () => {
      const once = effectiveStatus(sub('trialing', -1, 15), now);
      expect(effectiveStatus({ ...sub('trialing', -1, 15), status: once }, now)).toBe(once);
    });

    it('reports remaining days and progress for a 15-day trial', () => {
      const s = subscriptionState(sub('trialing', 10, 15), now);
      expect(s).toMatchObject({ status: 'trialing', hasAccess: true, remainingDays: 10 });
      expect(s.totalDays).toBe(15);
      expect(s.elapsed).toBeCloseTo(5 / 15);
    });
  });

  describe('paid periods', () => {
    it('moves an ended period to past_due for the grace period, then expired', () => {
      expect(effectiveStatus(sub('active', 5), now)).toBe('active');
      expect(effectiveStatus(sub('active', -1), now)).toBe('past_due');
      expect(effectiveStatus(sub('past_due', -2), now)).toBe('past_due');
      expect(effectiveStatus(sub('active', -3), now)).toBe('expired');
      expect(effectiveStatus(sub('past_due', -4), now)).toBe('expired');
    });

    it('keeps cancelled access until the period ends', () => {
      expect(effectiveStatus(sub('cancelled', 5), now)).toBe('cancelled');
      expect(effectiveStatus(sub('cancelled', -1), now)).toBe('expired');
    });

    it('never expires complimentary accounts (no period end)', () => {
      expect(effectiveStatus(sub('active', null), now)).toBe('active');
    });

    it('never changes administrative or payment-pending statuses with time', () => {
      for (const s of ['suspended', 'expired', 'pending_payment'] as const) {
        expect(effectiveStatus(sub(s, -10), now)).toBe(s);
        expect(effectiveStatus(sub(s, 10), now)).toBe(s);
      }
    });
  });

  it('grants operational access only to trialing, active, past_due and cancelled', () => {
    expect(SUBSCRIPTION_STATUSES.filter(hasAccess)).toEqual([
      'trialing',
      'active',
      'past_due',
      'cancelled',
    ]);
  });

  it('enforces the state machine', () => {
    expect(canTransition('trialing', 'expired')).toBe(true);
    expect(canTransition('expired', 'pending_payment')).toBe(true);
    expect(canTransition('pending_payment', 'active')).toBe(true);
    expect(canTransition('pending_payment', 'expired')).toBe(true);
    expect(canTransition('expired', 'active')).toBe(true);
    expect(canTransition('suspended', 'active')).toBe(true);
    // Payment pending never comes from a status that still has access.
    expect(canTransition('trialing', 'pending_payment')).toBe(false);
    expect(canTransition('active', 'pending_payment')).toBe(false);
    expect(canTransition('expired', 'cancelled')).toBe(false);
    expect(canTransition('expired', 'past_due')).toBe(false);
  });

  it('shows trial reminders at 7, 3 and 1 days, then expired', () => {
    expect(trialReminder('trialing', 10, true)).toBeNull();
    expect(trialReminder('trialing', 7, true)).toBe(7);
    expect(trialReminder('trialing', 4, true)).toBe(7);
    expect(trialReminder('trialing', 3, true)).toBe(3);
    expect(trialReminder('trialing', 1, true)).toBe(1);
    expect(trialReminder('expired', 0, true)).toBe('expired');
    expect(trialReminder('expired', 0, false)).toBeNull();
    expect(trialReminder('active', 3, false)).toBeNull();
  });

  it('adds billing cycles without overflowing short months', () => {
    expect(addCycle(new Date('2026-01-31T12:00:00Z'), 'monthly').toISOString()).toBe(
      '2026-02-28T12:00:00.000Z',
    );
    expect(addCycle(new Date('2028-02-29T00:00:00Z'), 'yearly').toISOString()).toBe(
      '2029-02-28T00:00:00.000Z',
    );
  });
});
