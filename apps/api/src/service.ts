/**
 * Application services — the use-cases the API exposes. This is the only layer
 * that orchestrates repositories, domain rules, and money-core. Routes stay
 * thin: parse input -> call a service -> serialize output.
 */

import { randomUUID } from "node:crypto";
import { Money } from "@mymoney/money-core";
import {
  accountBalance,
  netWorth,
  validateTransaction,
  type Account,
  type AccountType,
  type AccountRepository,
  type Clock,
  type FxRateProvider,
  type Transaction,
  type TransactionRepository,
} from "@mymoney/domain";

/** How money arrives over the wire: an exact decimal string + currency. */
export interface MoneyInput {
  amount: string; // decimal string, e.g. "12.34"
  currency: string;
}

export interface CreateAccountInput {
  name: string;
  type: AccountType;
  currency: string;
  openingBalance?: string; // decimal, default "0"
  openingDate?: string; // ISO date, default today
}

export interface CreateTransactionInput {
  accountId: string;
  date: string;
  amount: string; // decimal in the account's currency
  payee: string;
  categoryId?: string | null;
  splits?: Array<{ categoryId: string; amount: string; note?: string }>;
  notes?: string;
  tags?: string[];
}

export class ValidationError extends Error {
  constructor(public problems: string[]) {
    super(problems.join(" "));
    this.name = "ValidationError";
  }
}
export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

export class AppService {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly transactions: TransactionRepository,
    private readonly fx: FxRateProvider,
    private readonly clock: Clock,
  ) {}

  // ---- Accounts -------------------------------------------------------------

  async createAccount(userId: string, input: CreateAccountInput): Promise<Account> {
    const opening = Money.fromDecimal(input.openingBalance ?? "0", input.currency);
    const account: Account = {
      id: randomUUID(),
      userId,
      name: input.name.trim(),
      type: input.type,
      currency: input.currency.toUpperCase(),
      opening,
      openingDate: input.openingDate ?? this.clock.today(),
      archivedAt: null,
    };
    if (!account.name) throw new ValidationError(["Account name is required."]);
    return this.accounts.create(account);
  }

  async listAccounts(userId: string): Promise<Array<{ account: Account; balance: Money }>> {
    const accounts = await this.accounts.listByUser(userId);
    const result: Array<{ account: Account; balance: Money }> = [];
    for (const account of accounts) {
      const txns = await this.transactions.listByAccount(account.id);
      result.push({ account, balance: accountBalance(account, txns) });
    }
    return result;
  }

  async archiveAccount(userId: string, id: string): Promise<Account> {
    const account = await this.accounts.findById(userId, id);
    if (!account) throw new NotFoundError("Account");
    return this.accounts.update({ ...account, archivedAt: this.clock.now().toISOString() });
  }

  // ---- Transactions ---------------------------------------------------------

  async createTransaction(userId: string, input: CreateTransactionInput): Promise<Transaction> {
    const account = await this.accounts.findById(userId, input.accountId);
    if (!account) throw new NotFoundError("Account");

    const currency = account.currency;
    const amount = Money.fromDecimal(input.amount, currency);
    const splits =
      input.splits?.map((s) => ({
        categoryId: s.categoryId,
        amount: Money.fromDecimal(s.amount, currency),
        note: s.note,
      })) ?? [];

    const txn: Transaction = {
      id: randomUUID(),
      accountId: account.id,
      date: input.date,
      amount,
      payee: input.payee.trim(),
      categoryId: splits.length > 0 ? null : (input.categoryId ?? null),
      splits,
      status: "uncleared",
      notes: input.notes,
      tags: input.tags ?? [],
      transferGroupId: null,
      externalFingerprint: null,
      createdAt: this.clock.now().toISOString(),
    };
    (txn as Transaction & { userId: string }).userId = userId;

    const problems = validateTransaction(txn);
    if (problems.length > 0) throw new ValidationError(problems);

    return this.transactions.create(txn);
  }

  async listTransactions(
    userId: string,
    accountId: string,
    opts?: { from?: string; to?: string; limit?: number; offset?: number },
  ): Promise<Transaction[]> {
    const account = await this.accounts.findById(userId, accountId);
    if (!account) throw new NotFoundError("Account");
    return this.transactions.listByAccount(accountId, opts);
  }

  async deleteTransaction(userId: string, id: string): Promise<void> {
    const txn = await this.transactions.findById(userId, id);
    if (!txn) throw new NotFoundError("Transaction");
    await this.transactions.delete(userId, id);
  }

  // ---- Reports --------------------------------------------------------------

  async netWorth(userId: string, baseCurrency: string): Promise<Money> {
    const base = baseCurrency.toUpperCase();
    const accounts = await this.accounts.listByUser(userId);
    const allTxns: Transaction[] = [];
    for (const a of accounts) allTxns.push(...(await this.transactions.listByAccount(a.id)));

    // Pre-resolve the rates we need so the pure domain function stays sync.
    const today = this.clock.today();
    const rates = new Map<string, string>();
    for (const a of accounts) {
      if (a.currency !== base && !rates.has(a.currency)) {
        rates.set(a.currency, await this.fx.getRate(a.currency, base, today));
      }
    }
    return netWorth(accounts, allTxns, base, (from) => (from === base ? "1" : rates.get(from)!));
  }
}
