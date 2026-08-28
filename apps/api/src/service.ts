/**
 * Application services — the use-cases the API exposes. This is the only layer
 * that orchestrates repositories, domain rules, and money-core. Routes stay
 * thin: parse input -> call a service -> serialize output.
 */

import { randomUUID } from "node:crypto";
import { Money, convert } from "@mymoney/money-core";
import {
  accountBalance,
  netWorth,
  validateTransaction,
  type Account,
  type AccountType,
  type AccountRepository,
  type Budget,
  type BudgetRepository,
  type Category,
  type CategoryRepository,
  type Clock,
  type FxRateProvider,
  type Transaction,
  type TransactionRepository,
} from "@mymoney/domain";
import {
  parseCsv,
  mapCsvRows,
  type CsvMapping,
  type DraftTransaction,
  type RowError,
} from "./import/csv.js";

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
  /** Set by importers for dedupe; not normally provided by clients. */
  externalFingerprint?: string | null;
}

export interface ImportCsvInput {
  accountId: string;
  csv: string;
  hasHeader?: boolean;
  mapping: CsvMapping;
}

export interface ImportResult {
  imported: number;
  skippedDuplicates: number;
  errors: string[];
}

export interface CreateBudgetInput {
  categoryId: string;
  period: string; // YYYY-MM
  limit: string; // decimal
  currency: string;
  rollover?: boolean;
}

export interface BudgetLine {
  budget: Budget;
  spent: Money;
  remaining: Money;
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
    private readonly budgets: BudgetRepository,
    private readonly categories: CategoryRepository,
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
      externalFingerprint: input.externalFingerprint ?? null,
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

  // ---- CSV import -----------------------------------------------------------

  async importCsv(userId: string, input: ImportCsvInput): Promise<ImportResult> {
    const account = await this.accounts.findById(userId, input.accountId);
    if (!account) throw new NotFoundError("Account");

    let drafts: DraftTransaction[];
    let rowErrors: RowError[];
    try {
      const rows = parseCsv(input.csv);
      ({ drafts, errors: rowErrors } = mapCsvRows(rows, { hasHeader: input.hasHeader, mapping: input.mapping }));
    } catch (err) {
      // A bad column mapping is a client error, not a server fault.
      throw new ValidationError([(err as Error).message]);
    }
    const problems = rowErrors.map((e) => `Row ${e.row}: ${e.message}`);

    let imported = 0;
    let skippedDuplicates = 0;
    for (const draft of drafts) {
      try {
        const money = Money.fromDecimal(draft.amount, account.currency);
        const fingerprint = `csv:${draft.date}|${money.amount}|${draft.payee.trim().toLowerCase()}`;
        if (await this.transactions.existsByFingerprint(account.id, fingerprint)) {
          skippedDuplicates++;
          continue;
        }
        await this.createTransaction(userId, {
          accountId: account.id,
          date: draft.date,
          amount: draft.amount,
          payee: draft.payee,
          categoryId: draft.categoryId ?? null,
          externalFingerprint: fingerprint,
        });
        imported++;
      } catch (err) {
        problems.push(`"${draft.payee}" on ${draft.date}: ${(err as Error).message}`);
      }
    }
    return { imported, skippedDuplicates, errors: problems };
  }

  // ---- Budgets --------------------------------------------------------------

  async createBudget(userId: string, input: CreateBudgetInput): Promise<Budget> {
    if (!/^\d{4}-\d{2}$/.test(input.period)) {
      throw new ValidationError(["Budget period must be in YYYY-MM format."]);
    }
    const budget: Budget = {
      id: randomUUID(),
      userId,
      categoryId: input.categoryId,
      period: input.period,
      limit: Money.fromDecimal(input.limit, input.currency),
      rollover: input.rollover ?? false,
    };
    return this.budgets.upsert(budget);
  }

  /** Budget-vs-actual for a period: how much of each budget has been spent. */
  async budgetReport(userId: string, period: string): Promise<BudgetLine[]> {
    const budgets = await this.budgets.listByPeriod(userId, period);
    const allTxns = await this.transactions.listByUser(userId);
    const inPeriod = allTxns.filter((t) => t.date.slice(0, 7) === period);

    const lines: BudgetLine[] = [];
    for (const budget of budgets) {
      const currency = budget.limit.currency;
      let spent = Money.zero(currency);
      for (const txn of inPeriod) {
        const matching: Money[] =
          txn.splits.length > 0
            ? txn.splits.filter((s) => s.categoryId === budget.categoryId).map((s) => s.amount)
            : txn.categoryId === budget.categoryId
              ? [txn.amount]
              : [];
        for (const amount of matching) {
          if (!amount.isNegative()) continue; // only expenses count as spend
          const magnitude = amount.negate();
          const converted =
            magnitude.currency === currency
              ? magnitude
              : convert(magnitude, currency, await this.fx.getRate(magnitude.currency, currency, txn.date));
          spent = spent.plus(converted);
        }
      }
      lines.push({ budget, spent, remaining: budget.limit.minus(spent) });
    }
    return lines;
  }

  // ---- Export (data ownership) ---------------------------------------------

  async exportAll(userId: string): Promise<{
    accounts: Account[];
    transactions: Transaction[];
    budgets: Budget[];
    categories: Category[];
  }> {
    const [accounts, transactions, budgets, categories] = await Promise.all([
      this.accounts.listByUser(userId, { includeArchived: true }),
      this.transactions.listByUser(userId),
      this.budgets.listByUser(userId),
      this.categories.listForUser(userId),
    ]);
    return { accounts, transactions, budgets, categories };
  }

  /** A flat CSV of the user's transactions (for spreadsheet round-tripping). */
  async transactionsCsv(userId: string): Promise<string> {
    const txns = await this.transactions.listByUser(userId);
    const header = ["date", "account", "payee", "amount", "currency", "category", "status"];
    const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const rows = txns.map((t) =>
      [
        t.date,
        t.accountId,
        t.payee,
        t.amount.toDecimalString(),
        t.amount.currency,
        t.categoryId ?? (t.splits.length ? "(split)" : ""),
        t.status,
      ]
        .map((c) => escape(String(c)))
        .join(","),
    );
    return [header.join(","), ...rows].join("\n");
  }
}
