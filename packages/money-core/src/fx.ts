/**
 * Foreign-exchange conversion.
 *
 * Converting between currencies is the *only* sanctioned way to combine amounts
 * of different currencies. The rate is expressed exactly (a decimal string is
 * preferred) and the whole computation stays in bigint, so the converted minor
 * units are deterministic and correctly rounded for the target currency's
 * exponent — including when source and target have different exponents
 * (e.g. JPY -> BHD, 0 vs 3 decimals).
 */

import { getExponent } from "./currency.js";
import { Money } from "./money.js";
import { divRound, type RoundingMode } from "./rounding.js";

/**
 * Convert `money` into `targetCurrency` using `rate`, where
 *   value(target) = value(source) * rate
 *
 * `rate` is target units per one source unit (e.g. USD->EUR rate 0.92 means
 * 1 USD = 0.92 EUR). Pass it as a string ("0.9234") to keep it exact.
 */
export function convert(
  money: Money,
  targetCurrency: string,
  rate: string | number,
  mode: RoundingMode = "HALF_UP",
): Money {
  const target = targetCurrency.toUpperCase();
  const sourceExp = getExponent(money.currency);
  const targetExp = getExponent(target);

  const { num: rateNum, scale: rateScale } = parseRate(rate);

  // target_minor = round( amount * rate * 10^targetExp / 10^sourceExp )
  //   with rate = rateNum / 10^rateScale
  //   => numerator   = amount * rateNum * 10^targetExp
  //      denominator = 10^(rateScale + sourceExp)
  const numerator = money.amount * rateNum * 10n ** BigInt(targetExp);
  const denominator = 10n ** (rateScale + BigInt(sourceExp));

  // divRound needs a positive denominator; sign lives in the numerator.
  const sign = numerator < 0n ? -1n : 1n;
  const minor = sign * divRound(sign * numerator, denominator, mode);
  return Money.ofMinor(minor, target);
}

function parseRate(rate: string | number): { num: bigint; scale: bigint } {
  const raw = typeof rate === "number" ? String(rate) : rate.trim();
  const match = /^(\d*)(?:\.(\d+))?$/.exec(raw); // rates are non-negative
  if (!match || (match[1] === "" && (match[2] ?? "") === "")) {
    throw new Error(`Invalid FX rate: "${rate}"`);
  }
  const intPart = match[1] || "0";
  const fracPart = match[2] || "";
  const num = BigInt(intPart + fracPart);
  if (num === 0n) throw new Error("FX rate must be greater than zero");
  return { num, scale: BigInt(fracPart.length) };
}
