/**
 * Currency registry.
 *
 * Every amount in MyMoney is stored as an integer number of *minor units*
 * (cents, fils, yen). To convert to/from a human decimal we need each
 * currency's exponent (number of decimal places). This registry is the single
 * source of truth. Unknown currencies throw rather than silently defaulting to
 * 2 places — a wrong exponent corrupts money math.
 */

export class UnknownCurrencyError extends Error {
  constructor(code: string) {
    super(`Unknown currency: "${code}". Add it to the currency registry.`);
    this.name = "UnknownCurrencyError";
  }
}

/** ISO 4217 code -> number of minor-unit decimal places (the "exponent"). */
const EXPONENTS: Readonly<Record<string, number>> = {
  // 2-decimal (the vast majority)
  USD: 2, EUR: 2, GBP: 2, CAD: 2, AUD: 2, NZD: 2, CHF: 2, SGD: 2, HKD: 2,
  CNY: 2, INR: 2, BRL: 2, MXN: 2, ZAR: 2, SEK: 2, NOK: 2, DKK: 2, PLN: 2,
  CZK: 2, RON: 2, TRY: 2, RUB: 2, ILS: 2, AED: 2, SAR: 2, QAR: 2, EGP: 2,
  PHP: 2, THB: 2, MYR: 2, IDR: 2, PKR: 2, NGN: 2, KES: 2, GHS: 2, MAD: 2,
  // 0-decimal (no minor unit)
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, HUF: 0, TWD: 0, XOF: 0, XAF: 0,
  // 3-decimal
  BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3, IQD: 3, LYD: 3,
};

/** Returns the minor-unit exponent for a currency (throws if unknown). */
export function getExponent(currency: string): number {
  const code = currency.toUpperCase();
  const exp = EXPONENTS[code];
  if (exp === undefined) throw new UnknownCurrencyError(currency);
  return exp;
}

/** True if the currency is present in the registry. */
export function isKnownCurrency(currency: string): boolean {
  return EXPONENTS[currency.toUpperCase()] !== undefined;
}

/** 10 ** exponent as a bigint — the number of minor units in one major unit. */
export function minorUnitScale(currency: string): bigint {
  return 10n ** BigInt(getExponent(currency));
}

/** All registered currency codes (useful for pickers / validation). */
export function knownCurrencies(): string[] {
  return Object.keys(EXPONENTS);
}
