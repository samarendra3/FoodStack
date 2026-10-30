/** ISO 4217 currency code, e.g. "INR". */
export type CurrencyCode = string;

/** Amounts are always integers in minor units (paise, cents). Never floats. */
export interface Money {
  amount: number;
  currency: CurrencyCode;
}
