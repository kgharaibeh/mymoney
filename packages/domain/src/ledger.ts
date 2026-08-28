/**
 * Ledger rules — the invariants that keep the books correct.
 *
 * The central rule: an account's balance is *derived* from its opening balance
 * plus its transactions. It is never stored as a mutable number that could
 * drift out of sync. Everything here is pure and uses `money-core`, so it is
 * trivially testable and free of I/O.
 */

import { Money, convert, sumMoney } from "@mymoney/money-core";
import { type Account, type Transaction } from "./types.js";

/** Derived balance of an account = opening + Σ(transactions in that account). */
export function accountBalance(account: Account, transactions: Transaction[]): Money {
  return transactions
    .filter((t) => t.accountId === account.id)
    .reduce((acc, t) => acc.plus(t.amount), account.opening);
}

/**
 * Validate a transaction's splits. When a transaction is split, the signed
 * split lines must sum to exactly the transaction total — no residual pennies.
 * Returns the list of problems (empty = valid).
 */
export function validateTransaction(txn: Transaction): string[] {
  const problems: string[] = [];

  if (txn.splits.length > 0) {
    if (txn.categoryId !== null) {
      problems.push("A split transaction must not also set a single categoryId.");
    }
    if (txn.splits.length < 2) {
      problems.push("A split transaction needs at least two split lines.");
    }
    try {
      const splitTotal = sumMoney(
        txn.splits.map((s) => s.amount),
        txn.amount.currency,
      );
      if (!splitTotal.equals(txn.amount)) {
        problems.push(
          `Split lines sum to ${splitTotal.toString()} but the transaction total is ${txn.amount.toString()}.`,
        );
      }
    } catch (err) {
      problems.push((err as Error).message);
    }
  } else if (txn.categoryId === null && txn.transferGroupId === null) {
    problems.push("A non-split, non-transfer transaction must have a category.");
  }

  return problems;
}

/**
 * Net worth in a base currency = the signed sum of every non-archived account's
 * balance, converted from its own currency. We use a signed model: liability
 * accounts (credit cards, loans) carry negative balances because spending on
 * them is money out, so they subtract from net worth naturally — no special
 * casing needed. `rateFor(from)` returns the FX rate (base units per one `from`
 * unit); it may return "1" for the base currency itself.
 */
export function netWorth(
  accounts: Account[],
  transactions: Transaction[],
  baseCurrency: string,
  rateFor: (fromCurrency: string) => string,
): Money {
  let total = Money.zero(baseCurrency);
  for (const account of accounts) {
    if (account.archivedAt) continue;
    const balance = accountBalance(account, transactions);
    const inBase =
      balance.currency === baseCurrency
        ? balance
        : convert(balance, baseCurrency, rateFor(balance.currency));
    total = total.plus(inBase);
  }
  return total;
}
