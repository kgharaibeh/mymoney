// Money formatting reuses @mymoney/money-core — the same value type the server
// and domain use — so display math can never disagree with the ledger.
import { Money } from "@mymoney/money-core";
import type { MoneyDTO } from "./api";

export function money(m: MoneyDTO, locale?: string): string {
  try {
    return Money.ofMinor(m.amountMinor, m.currency).format(locale ?? navigator.language);
  } catch {
    return `${m.decimal} ${m.currency}`;
  }
}

/** Sign class for coloring amounts (negative = spend). */
export function signClass(m: MoneyDTO): "pos" | "neg" | "zero" {
  const n = BigInt(m.amountMinor);
  return n > 0n ? "pos" : n < 0n ? "neg" : "zero";
}

export function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
