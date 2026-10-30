/** Currencies whose minor unit is not 2 digits. Extend as countries are added. */
const MINOR_UNIT_DIGITS: Record<string, number> = { JPY: 0, KWD: 3, BHD: 3, OMR: 3 };

export function minorUnitDigits(currency: string): number {
  return MINOR_UNIT_DIGITS[currency.toUpperCase()] ?? 2;
}

/** Formats an integer minor-unit amount for display. */
export function formatMoney(amountMinor: number, currency: string, locale = 'en-IN'): string {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError(`Money amount must be a safe integer, received ${amountMinor}`);
  }
  const digits = minorUnitDigits(currency);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amountMinor / 10 ** digits);
}
