/**
 * Money — an immutable value object: an integer count of minor units plus an
 * explicit ISO-4217 currency.
 *
 * Rules enforced here so the rest of the app can't get money wrong:
 *   - No floats. Ever. All arithmetic is on `bigint` minor units.
 *   - No mixing currencies without an explicit conversion (see fx.ts).
 *   - Splitting an amount never loses or invents a minor unit (`allocate`).
 */

import { getExponent } from "./currency.js";
import { divRound, type RoundingMode } from "./rounding.js";

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Cannot operate on different currencies: ${a} vs ${b}`);
    this.name = "CurrencyMismatchError";
  }
}

/** A scalar factor for `times()` — a plain number or an exact decimal string. */
export type Factor = number | string;

export class Money {
  /** Signed integer number of minor units (e.g. cents). */
  readonly amount: bigint;
  /** Uppercase ISO 4217 code. */
  readonly currency: string;

  private constructor(amount: bigint, currency: string) {
    this.amount = amount;
    this.currency = currency;
  }

  // ---- Construction ---------------------------------------------------------

  /** Build from an integer count of minor units. */
  static ofMinor(amount: bigint | number | string, currency: string): Money {
    const code = currency.toUpperCase();
    getExponent(code); // validate currency early
    return new Money(BigInt(amount), code);
  }

  /**
   * Build from a decimal string or number, e.g. `fromDecimal("12.34", "USD")`.
   * If the input has more decimal places than the currency supports it is
   * rounded using `mode` (default HALF_UP). Prefer passing a string to avoid
   * float imprecision creeping in before it ever reaches Money.
   */
  static fromDecimal(
    value: string | number,
    currency: string,
    mode: RoundingMode = "HALF_UP",
  ): Money {
    const code = currency.toUpperCase();
    const exp = getExponent(code);
    const raw = typeof value === "number" ? numberToDecimalString(value) : value.trim();

    const match = /^([+-]?)(\d*)(?:\.(\d+))?$/.exec(raw);
    if (!match || (match[2] === "" && (match[3] ?? "") === "")) {
      throw new Error(`Invalid decimal value: "${value}"`);
    }
    const sign = match[1] === "-" ? -1n : 1n;
    const intPart = match[2] || "0";
    const fracPart = match[3] || "";

    // digits / 10^scale is the exact decimal value; we want it at 10^exp.
    const digits = BigInt(intPart + fracPart);
    const scale = BigInt(fracPart.length);
    const targetScale = BigInt(exp);

    let minor: bigint;
    if (scale <= targetScale) {
      minor = digits * 10n ** (targetScale - scale); // exact, no rounding
    } else {
      minor = divRound(digits, 10n ** (scale - targetScale), mode);
    }
    return new Money(sign * minor, code);
  }

  /** The additive identity for a currency. */
  static zero(currency: string): Money {
    return Money.ofMinor(0n, currency);
  }

  // ---- Arithmetic -----------------------------------------------------------

  plus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount + other.amount, this.currency);
  }

  minus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount - other.amount, this.currency);
  }

  /**
   * Multiply by a scalar factor (e.g. a tax rate or quantity), rounding the
   * result to whole minor units. The factor is parsed exactly, so
   * `times("0.0825")` introduces no float error.
   */
  times(factor: Factor, mode: RoundingMode = "HALF_UP"): Money {
    const { num, scale } = parseFactor(factor);
    const result = divRound(this.amount * num, 10n ** scale, mode);
    return new Money(result, this.currency);
  }

  negate(): Money {
    return new Money(-this.amount, this.currency);
  }

  abs(): Money {
    return this.amount < 0n ? this.negate() : this;
  }

  // ---- Allocation (no penny left behind) ------------------------------------

  /**
   * Split this amount across the given integer ratios so the parts sum back to
   * exactly the original — no minor unit lost or invented. Leftover units from
   * integer division are handed out one at a time to the parts with the largest
   * division remainder (ties broken by order), which is stable and fair.
   *
   * Example: $0.05 allocated by [1,1,1] -> [0.02, 0.02, 0.01].
   */
  allocate(ratios: Array<number | bigint>): Money[] {
    if (ratios.length === 0) throw new Error("allocate requires at least one ratio");
    const r = ratios.map((x) => BigInt(x));
    if (r.some((x) => x < 0n)) throw new Error("allocate ratios must be non-negative");
    const total = r.reduce((a, b) => a + b, 0n);
    if (total === 0n) throw new Error("allocate ratios must not all be zero");

    // Work on the magnitude, reapply sign at the end, so remainder distribution
    // behaves identically for positive and negative amounts.
    const sign = this.amount < 0n ? -1n : 1n;
    const magnitude = sign * this.amount;

    const shares: bigint[] = new Array(r.length);
    const remainders: Array<{ index: number; rem: bigint }> = [];
    let distributed = 0n;

    for (let i = 0; i < r.length; i++) {
      const numerator = magnitude * r[i];
      const q = numerator / total;
      const rem = numerator % total;
      shares[i] = q;
      distributed += q;
      remainders.push({ index: i, rem });
    }

    let leftover = magnitude - distributed; // number of extra minor units to place
    remainders.sort((a, b) => (b.rem === a.rem ? a.index - b.index : b.rem > a.rem ? 1 : -1));
    for (let i = 0; leftover > 0n; i++, leftover--) {
      shares[remainders[i].index] += 1n;
    }

    return shares.map((s) => new Money(sign * s, this.currency));
  }

  /** Distribute evenly into `n` parts (a convenience over `allocate`). */
  distribute(n: number): Money[] {
    if (!Number.isInteger(n) || n <= 0) throw new Error("distribute n must be a positive integer");
    return this.allocate(new Array(n).fill(1));
  }

  // ---- Comparison -----------------------------------------------------------

  /** -1, 0, or 1. Throws on currency mismatch. */
  compareTo(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.amount < other.amount) return -1;
    if (this.amount > other.amount) return 1;
    return 0;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount === other.amount;
  }

  isZero(): boolean {
    return this.amount === 0n;
  }
  isNegative(): boolean {
    return this.amount < 0n;
  }
  isPositive(): boolean {
    return this.amount > 0n;
  }

  // ---- Serialization / display ---------------------------------------------

  /** Human decimal string, e.g. "1234.56" (no grouping, no symbol). */
  toDecimalString(): string {
    const exp = getExponent(this.currency);
    const negative = this.amount < 0n;
    const a = (negative ? -this.amount : this.amount).toString();
    if (exp === 0) return (negative ? "-" : "") + a;
    const padded = a.padStart(exp + 1, "0");
    const int = padded.slice(0, padded.length - exp);
    const frac = padded.slice(padded.length - exp);
    return `${negative ? "-" : ""}${int}.${frac}`;
  }

  /** Locale-aware formatted string, e.g. "$1,234.56". */
  format(locale = "en-US"): string {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: this.currency,
    }).format(Number(this.toDecimalString()));
  }

  /** JSON-safe wire form. `amountMinor` is a string to survive large bigints. */
  toJSON(): { amountMinor: string; currency: string } {
    return { amountMinor: this.amount.toString(), currency: this.currency };
  }

  static fromJSON(json: { amountMinor: string; currency: string }): Money {
    return Money.ofMinor(json.amountMinor, json.currency);
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.currency}`;
  }

  // ---- Internals ------------------------------------------------------------

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}

/** Sum a list of Money of the same currency (empty list needs a currency). */
export function sumMoney(items: Money[], currencyIfEmpty?: string): Money {
  if (items.length === 0) {
    if (!currencyIfEmpty) throw new Error("sumMoney of empty list needs a currency");
    return Money.zero(currencyIfEmpty);
  }
  return items.reduce((acc, m) => acc.plus(m));
}

// ---- helpers ---------------------------------------------------------------

/** Parse a factor into an exact rational num / 10^scale. */
function parseFactor(factor: Factor): { num: bigint; scale: bigint } {
  const raw = typeof factor === "number" ? numberToDecimalString(factor) : String(factor).trim();
  const match = /^([+-]?)(\d*)(?:\.(\d+))?$/.exec(raw);
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) {
    throw new Error(`Invalid factor: "${factor}"`);
  }
  const sign = match[1] === "-" ? -1n : 1n;
  const intPart = match[2] || "0";
  const fracPart = match[3] || "";
  return { num: sign * BigInt(intPart + fracPart), scale: BigInt(fracPart.length) };
}

/** Convert a JS number to a plain decimal string without exponent notation. */
function numberToDecimalString(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Non-finite number: ${value}`);
  if (Number.isInteger(value)) return value.toString();
  // Avoid scientific notation for small/large magnitudes.
  const s = value.toString();
  if (!s.includes("e") && !s.includes("E")) return s;
  return value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
}
