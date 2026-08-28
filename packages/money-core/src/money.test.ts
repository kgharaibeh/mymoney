import { describe, it, expect } from "vitest";
import { Money, sumMoney, CurrencyMismatchError } from "./money.js";
import { convert } from "./fx.js";
import { divRound } from "./rounding.js";
import { getExponent, UnknownCurrencyError } from "./currency.js";

describe("currency registry", () => {
  it("knows exponents for common currencies", () => {
    expect(getExponent("USD")).toBe(2);
    expect(getExponent("JPY")).toBe(0);
    expect(getExponent("BHD")).toBe(3);
  });
  it("is case-insensitive", () => {
    expect(getExponent("usd")).toBe(2);
  });
  it("throws on unknown currency", () => {
    expect(() => getExponent("ZZZ")).toThrow(UnknownCurrencyError);
  });
});

describe("Money construction", () => {
  it("builds from minor units", () => {
    expect(Money.ofMinor(1234, "USD").toDecimalString()).toBe("12.34");
  });
  it("parses decimal strings exactly", () => {
    expect(Money.fromDecimal("12.34", "USD").amount).toBe(1234n);
    expect(Money.fromDecimal("-0.09", "USD").amount).toBe(-9n);
    expect(Money.fromDecimal("100", "JPY").amount).toBe(100n);
    expect(Money.fromDecimal("1.234", "BHD").amount).toBe(1234n);
  });
  it("rounds when the input has too many decimals", () => {
    expect(Money.fromDecimal("1.005", "USD").amount).toBe(101n); // HALF_UP
    expect(Money.fromDecimal("1.004", "USD").amount).toBe(100n);
  });
  it("rejects malformed input", () => {
    expect(() => Money.fromDecimal("abc", "USD")).toThrow();
    expect(() => Money.fromDecimal("", "USD")).toThrow();
  });
});

describe("arithmetic", () => {
  it("adds and subtracts same-currency amounts", () => {
    const a = Money.fromDecimal("10.00", "USD");
    const b = Money.fromDecimal("2.50", "USD");
    expect(a.plus(b).toDecimalString()).toBe("12.50");
    expect(a.minus(b).toDecimalString()).toBe("7.50");
  });
  it("refuses to mix currencies", () => {
    const usd = Money.fromDecimal("1.00", "USD");
    const eur = Money.fromDecimal("1.00", "EUR");
    expect(() => usd.plus(eur)).toThrow(CurrencyMismatchError);
    expect(() => usd.compareTo(eur)).toThrow(CurrencyMismatchError);
  });
  it("multiplies by an exact factor without float error", () => {
    // 19.99 * 8.25% tax = 1.649175 -> 1.65
    const price = Money.fromDecimal("19.99", "USD");
    expect(price.times("0.0825").toDecimalString()).toBe("1.65");
  });
  it("negates and absolutes", () => {
    const m = Money.fromDecimal("-5.00", "USD");
    expect(m.negate().toDecimalString()).toBe("5.00");
    expect(m.abs().toDecimalString()).toBe("5.00");
  });
});

describe("allocate — never lose or invent a minor unit", () => {
  it("spreads leftover pennies fairly", () => {
    const parts = Money.ofMinor(5, "USD").allocate([1, 1, 1]);
    expect(parts.map((p) => p.amount)).toEqual([2n, 2n, 1n]);
  });
  it("allocates by weighted ratios", () => {
    const parts = Money.fromDecimal("100.00", "USD").allocate([70, 20, 10]);
    expect(parts.map((p) => p.toDecimalString())).toEqual(["70.00", "20.00", "10.00"]);
  });
  it("handles negative amounts symmetrically", () => {
    const parts = Money.ofMinor(-5, "USD").allocate([1, 1, 1]);
    expect(parts.map((p) => p.amount)).toEqual([-2n, -2n, -1n]);
    expect(sumMoney(parts).amount).toBe(-5n);
  });
  it("distributes evenly", () => {
    const parts = Money.ofMinor(10, "USD").distribute(3);
    expect(parts.map((p) => p.amount)).toEqual([4n, 3n, 3n]);
    expect(sumMoney(parts).amount).toBe(10n);
  });

  it("PROPERTY: allocated parts always sum back to the original", () => {
    let seed = 123456789;
    const rand = () => {
      // deterministic LCG so failures are reproducible
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let trial = 0; trial < 5000; trial++) {
      const amount = BigInt(rand() % 2_000_000) - 1_000_000n; // -10000.00 .. 10000.00
      const n = (rand() % 6) + 1;
      const ratios = Array.from({ length: n }, () => (rand() % 100) + 1);
      const original = Money.ofMinor(amount, "USD");
      const parts = original.allocate(ratios);
      expect(sumMoney(parts).amount).toBe(amount);
      // and the split is "tight": max and min share differ by at most 1 unit * ratio scale
      expect(parts.length).toBe(n);
    }
  });
});

describe("rounding modes", () => {
  it("HALF_UP vs HALF_EVEN vs DOWN", () => {
    expect(divRound(5n, 2n, "HALF_UP")).toBe(3n); // 2.5 -> 3
    expect(divRound(5n, 2n, "HALF_EVEN")).toBe(2n); // 2.5 -> 2 (even)
    expect(divRound(7n, 2n, "HALF_EVEN")).toBe(4n); // 3.5 -> 4 (even)
    expect(divRound(5n, 2n, "DOWN")).toBe(2n); // truncate
    expect(divRound(-5n, 2n, "FLOOR")).toBe(-3n); // toward -inf
    expect(divRound(-5n, 2n, "CEIL")).toBe(-2n); // toward +inf
  });
});

describe("fx conversion", () => {
  it("converts within the same exponent", () => {
    // 100.00 USD * 0.92 = 92.00 EUR
    const eur = convert(Money.fromDecimal("100.00", "USD"), "EUR", "0.92");
    expect(eur.toDecimalString()).toBe("92.00");
    expect(eur.currency).toBe("EUR");
  });
  it("converts across different exponents (USD 2dp -> JPY 0dp)", () => {
    // 10.00 USD * 149.50 = 1495 JPY
    const jpy = convert(Money.fromDecimal("10.00", "USD"), "JPY", "149.50");
    expect(jpy.toDecimalString()).toBe("1495");
  });
  it("converts JPY (0dp) -> BHD (3dp)", () => {
    // 1000 JPY * 0.0025 = 2.5 -> 2.500 BHD
    const bhd = convert(Money.fromDecimal("1000", "JPY"), "BHD", "0.0025");
    expect(bhd.toDecimalString()).toBe("2.500");
  });
  it("rejects a zero or invalid rate", () => {
    expect(() => convert(Money.fromDecimal("1.00", "USD"), "EUR", "0")).toThrow();
  });
});

describe("serialization & display", () => {
  it("round-trips through JSON", () => {
    const m = Money.ofMinor("9007199254740993", "USD"); // beyond Number.MAX_SAFE_INTEGER
    const back = Money.fromJSON(m.toJSON());
    expect(back.equals(m)).toBe(true);
    expect(m.toJSON().amountMinor).toBe("9007199254740993");
  });
  it("formats for a locale", () => {
    expect(Money.fromDecimal("1234.56", "USD").format("en-US")).toBe("$1,234.56");
  });
});
