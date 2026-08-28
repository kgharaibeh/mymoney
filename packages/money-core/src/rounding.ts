/**
 * Deterministic integer rounding.
 *
 * All MyMoney rounding goes through `divRound`, which divides two bigints and
 * rounds the quotient according to an explicit mode. Because everything is
 * integer arithmetic there is no floating-point drift — the result is exact and
 * reproducible on every platform.
 */

export type RoundingMode =
  | "HALF_UP" // .5 rounds away from zero (the everyday default)
  | "HALF_DOWN" // .5 rounds toward zero
  | "HALF_EVEN" // .5 rounds to the nearest even digit (banker's rounding)
  | "UP" // always away from zero
  | "DOWN" // always toward zero (truncate)
  | "CEIL" // toward +infinity
  | "FLOOR"; // toward -infinity

/**
 * Divide `numerator` by `denominator` (denominator MUST be > 0) and round the
 * quotient to an integer using `mode`. Sign of the numerator is handled
 * correctly for every mode.
 */
export function divRound(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode,
): bigint {
  if (denominator <= 0n) {
    throw new Error("divRound denominator must be positive");
  }

  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  let q = n / denominator;
  const r = n % denominator;

  if (r !== 0n) {
    const twiceR = r * 2n;
    let roundAwayFromZero: boolean;

    switch (mode) {
      case "DOWN":
        roundAwayFromZero = false;
        break;
      case "UP":
        roundAwayFromZero = true;
        break;
      case "FLOOR":
        // toward -infinity: for negative values that means away from zero
        roundAwayFromZero = negative;
        break;
      case "CEIL":
        // toward +infinity: for positive values that means away from zero
        roundAwayFromZero = !negative;
        break;
      case "HALF_UP":
        roundAwayFromZero = twiceR >= denominator;
        break;
      case "HALF_DOWN":
        roundAwayFromZero = twiceR > denominator;
        break;
      case "HALF_EVEN":
        if (twiceR > denominator) roundAwayFromZero = true;
        else if (twiceR < denominator) roundAwayFromZero = false;
        else roundAwayFromZero = q % 2n === 1n; // exactly half -> round to even
        break;
    }

    if (roundAwayFromZero!) q += 1n;
  }

  return negative ? -q : q;
}
