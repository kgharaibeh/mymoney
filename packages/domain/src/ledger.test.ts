import { describe, it, expect } from "vitest";
import { Money } from "@mymoney/money-core";
import { accountBalance, netWorth, validateTransaction } from "./ledger.js";
import type { Account, Transaction } from "./types.js";

function acct(over: Partial<Account>): Account {
  return {
    id: "a1",
    userId: "u1",
    name: "Checking",
    type: "checking",
    currency: "USD",
    opening: Money.fromDecimal("100.00", "USD"),
    openingDate: "2026-01-01",
    archivedAt: null,
    ...over,
  };
}

function txn(over: Partial<Transaction>): Transaction {
  return {
    id: "t1",
    accountId: "a1",
    date: "2026-01-02",
    amount: Money.fromDecimal("-10.00", "USD"),
    payee: "Coffee",
    categoryId: "food",
    splits: [],
    status: "cleared",
    tags: [],
    transferGroupId: null,
    externalFingerprint: null,
    createdAt: "2026-01-02T10:00:00Z",
    ...over,
  };
}

describe("accountBalance", () => {
  it("derives balance from opening + transactions", () => {
    const a = acct({});
    const txns = [
      txn({ id: "t1", amount: Money.fromDecimal("-10.00", "USD") }),
      txn({ id: "t2", amount: Money.fromDecimal("25.50", "USD") }),
    ];
    expect(accountBalance(a, txns).toDecimalString()).toBe("115.50");
  });
  it("ignores transactions from other accounts", () => {
    const a = acct({});
    const txns = [txn({ id: "t1", accountId: "other", amount: Money.fromDecimal("-999.00", "USD") })];
    expect(accountBalance(a, txns).toDecimalString()).toBe("100.00");
  });
});

describe("netWorth", () => {
  it("sums assets and negative-balance liabilities across currencies", () => {
    const checking = acct({ id: "chk", type: "checking", currency: "USD", opening: Money.fromDecimal("1000.00", "USD") });
    const card = acct({ id: "cc", type: "credit_card", currency: "USD", opening: Money.fromDecimal("-200.00", "USD") });
    const euro = acct({ id: "eur", type: "savings", currency: "EUR", opening: Money.fromDecimal("500.00", "EUR") });
    const rate = (from: string) => (from === "EUR" ? "1.10" : "1");
    // 1000 - 200 + (500 * 1.10 = 550) = 1350
    const nw = netWorth([checking, card, euro], [], "USD", rate);
    expect(nw.toDecimalString()).toBe("1350.00");
  });
  it("excludes archived accounts", () => {
    const a = acct({ id: "a", opening: Money.fromDecimal("100.00", "USD") });
    const archived = acct({ id: "b", opening: Money.fromDecimal("999.00", "USD"), archivedAt: "2026-02-01" });
    expect(netWorth([a, archived], [], "USD", () => "1").toDecimalString()).toBe("100.00");
  });
});

describe("validateTransaction", () => {
  it("accepts a simple categorized transaction", () => {
    expect(validateTransaction(txn({}))).toEqual([]);
  });
  it("requires split lines to sum to the total", () => {
    const t = txn({
      categoryId: null,
      amount: Money.fromDecimal("-30.00", "USD"),
      splits: [
        { categoryId: "food", amount: Money.fromDecimal("-20.00", "USD") },
        { categoryId: "tip", amount: Money.fromDecimal("-9.00", "USD") },
      ],
    });
    const problems = validateTransaction(t);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("Split lines sum to");
  });
  it("accepts split lines that sum exactly", () => {
    const t = txn({
      categoryId: null,
      amount: Money.fromDecimal("-30.00", "USD"),
      splits: [
        { categoryId: "food", amount: Money.fromDecimal("-20.00", "USD") },
        { categoryId: "tip", amount: Money.fromDecimal("-10.00", "USD") },
      ],
    });
    expect(validateTransaction(t)).toEqual([]);
  });
  it("accepts an uncategorized transaction (e.g. a fresh bank import)", () => {
    expect(validateTransaction(txn({ categoryId: null }))).toEqual([]);
  });
  it("rejects a split transaction that also sets a single category", () => {
    const t = txn({
      categoryId: "food",
      amount: Money.fromDecimal("-30.00", "USD"),
      splits: [
        { categoryId: "food", amount: Money.fromDecimal("-20.00", "USD") },
        { categoryId: "tip", amount: Money.fromDecimal("-10.00", "USD") },
      ],
    });
    expect(validateTransaction(t)).toContain("A split transaction must not also set a single categoryId.");
  });
});
