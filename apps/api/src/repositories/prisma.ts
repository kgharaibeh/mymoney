/**
 * Prisma / PostgreSQL adapter implementations of the domain ports.
 *
 * These mirror the in-memory adapters exactly — same interfaces, same behavior
 * — but persist to Postgres. Nothing in the domain, services, or routes changes
 * when you switch stores; only the wiring in server.ts does.
 *
 * Money mapping rule: DB stores `*Minor` BigInt columns + a currency code; we
 * rebuild a `Money` on the way out and unwrap `.amount` (a bigint) on the way
 * in. No floats ever touch the database.
 */

import { PrismaClient } from "@prisma/client";
import { Money } from "@mymoney/money-core";
import type {
  Account,
  AccountRepository,
  AccountType,
  AggregatorConnection,
  AggregatorConnectionRepository,
  AggregatorProviderName,
  Budget,
  BudgetRepository,
  CategorizationRule,
  CategorizationRuleRepository,
  Category,
  CategoryKind,
  CategoryRepository,
  ConnectionStatus,
  FxRateProvider,
  Transaction,
  TransactionRepository,
  TransactionStatus,
} from "@mymoney/domain";

// ---- Shared client ----------------------------------------------------------

let client: PrismaClient | null = null;
export function getPrisma(): PrismaClient {
  if (!client) client = new PrismaClient();
  return client;
}
export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}

// ---- Date helpers (DB `date` columns <-> "YYYY-MM-DD" strings) --------------

const toDbDate = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const fromDbDate = (d: Date): string => d.toISOString().slice(0, 10);

// ---- Row -> domain mappers --------------------------------------------------

type AccountRow = {
  id: string;
  userId: string;
  name: string;
  type: string;
  currency: string;
  openingAmountMinor: bigint;
  openingDate: Date;
  archivedAt: Date | null;
  connectionId: string | null;
  externalId: string | null;
};

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    type: row.type as AccountType,
    currency: row.currency,
    opening: Money.ofMinor(row.openingAmountMinor, row.currency),
    openingDate: fromDbDate(row.openingDate),
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    connectionId: row.connectionId,
    externalId: row.externalId,
  };
}

type SplitRow = { categoryId: string; amountMinor: bigint; note: string | null };
type TransactionRow = {
  id: string;
  accountId: string;
  date: Date;
  amountMinor: bigint;
  currency: string;
  payee: string;
  categoryId: string | null;
  status: string;
  notes: string | null;
  tags: string[];
  transferGroupId: string | null;
  externalFingerprint: string | null;
  createdAt: Date;
  splits?: SplitRow[];
};

function toTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    accountId: row.accountId,
    date: fromDbDate(row.date),
    amount: Money.ofMinor(row.amountMinor, row.currency),
    payee: row.payee,
    categoryId: row.categoryId,
    splits: (row.splits ?? []).map((s) => ({
      categoryId: s.categoryId,
      amount: Money.ofMinor(s.amountMinor, row.currency),
      note: s.note ?? undefined,
    })),
    status: row.status as TransactionStatus,
    notes: row.notes ?? undefined,
    tags: row.tags,
    transferGroupId: row.transferGroupId,
    externalFingerprint: row.externalFingerprint,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---- Repositories -----------------------------------------------------------

export class PrismaAccountRepository implements AccountRepository {
  constructor(private readonly prisma: PrismaClient = getPrisma()) {}

  async create(account: Account): Promise<Account> {
    const row = await this.prisma.account.create({
      data: {
        id: account.id,
        userId: account.userId,
        name: account.name,
        type: account.type,
        currency: account.currency,
        openingAmountMinor: account.opening.amount,
        openingDate: toDbDate(account.openingDate),
        archivedAt: account.archivedAt ? new Date(account.archivedAt) : null,
        connectionId: account.connectionId ?? null,
        externalId: account.externalId ?? null,
      },
    });
    return toAccount(row);
  }

  async findById(userId: string, id: string): Promise<Account | null> {
    const row = await this.prisma.account.findFirst({ where: { id, userId } });
    return row ? toAccount(row) : null;
  }

  async findByExternalId(userId: string, connectionId: string, externalId: string): Promise<Account | null> {
    const row = await this.prisma.account.findFirst({ where: { userId, connectionId, externalId } });
    return row ? toAccount(row) : null;
  }

  async listByUser(userId: string, opts?: { includeArchived?: boolean }): Promise<Account[]> {
    const rows = await this.prisma.account.findMany({
      where: { userId, ...(opts?.includeArchived ? {} : { archivedAt: null }) },
      orderBy: { name: "asc" },
    });
    return rows.map(toAccount);
  }

  async update(account: Account): Promise<Account> {
    const row = await this.prisma.account.update({
      where: { id: account.id },
      data: {
        name: account.name,
        type: account.type,
        archivedAt: account.archivedAt ? new Date(account.archivedAt) : null,
      },
    });
    return toAccount(row);
  }
}

export class PrismaTransactionRepository implements TransactionRepository {
  constructor(private readonly prisma: PrismaClient = getPrisma()) {}

  async create(txn: Transaction): Promise<Transaction> {
    const row = await this.prisma.transaction.create({
      data: {
        id: txn.id,
        accountId: txn.accountId,
        date: toDbDate(txn.date),
        amountMinor: txn.amount.amount,
        currency: txn.amount.currency,
        payee: txn.payee,
        categoryId: txn.categoryId,
        status: txn.status,
        notes: txn.notes ?? null,
        tags: txn.tags,
        transferGroupId: txn.transferGroupId,
        externalFingerprint: txn.externalFingerprint,
        splits: {
          create: txn.splits.map((s) => ({
            categoryId: s.categoryId,
            amountMinor: s.amount.amount,
            note: s.note ?? null,
          })),
        },
      },
      include: { splits: true },
    });
    return toTransaction(row);
  }

  async findById(_userId: string, id: string): Promise<Transaction | null> {
    const row = await this.prisma.transaction.findUnique({ where: { id }, include: { splits: true } });
    return row ? toTransaction(row) : null;
  }

  async listByAccount(
    accountId: string,
    opts?: { from?: string; to?: string; limit?: number; offset?: number },
  ): Promise<Transaction[]> {
    const rows = await this.prisma.transaction.findMany({
      where: {
        accountId,
        ...(opts?.from || opts?.to
          ? { date: { ...(opts.from ? { gte: toDbDate(opts.from) } : {}), ...(opts.to ? { lte: toDbDate(opts.to) } : {}) } }
          : {}),
      },
      include: { splits: true },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      ...(opts?.limit != null ? { take: opts.limit } : {}),
      ...(opts?.offset != null ? { skip: opts.offset } : {}),
    });
    return rows.map(toTransaction);
  }

  async listByUser(userId: string): Promise<Transaction[]> {
    const rows = await this.prisma.transaction.findMany({
      where: { account: { userId } },
      include: { splits: true },
    });
    return rows.map(toTransaction);
  }

  async update(txn: Transaction): Promise<Transaction> {
    // Replace splits wholesale so the lines always match the current total.
    const [, row] = await this.prisma.$transaction([
      this.prisma.transactionSplit.deleteMany({ where: { transactionId: txn.id } }),
      this.prisma.transaction.update({
        where: { id: txn.id },
        data: {
          date: toDbDate(txn.date),
          amountMinor: txn.amount.amount,
          currency: txn.amount.currency,
          payee: txn.payee,
          categoryId: txn.categoryId,
          status: txn.status,
          notes: txn.notes ?? null,
          tags: txn.tags,
          transferGroupId: txn.transferGroupId,
          splits: {
            create: txn.splits.map((s) => ({
              categoryId: s.categoryId,
              amountMinor: s.amount.amount,
              note: s.note ?? null,
            })),
          },
        },
        include: { splits: true },
      }),
    ]);
    return toTransaction(row);
  }

  async delete(_userId: string, id: string): Promise<void> {
    await this.prisma.transaction.delete({ where: { id } });
  }

  async existsByFingerprint(accountId: string, fingerprint: string): Promise<boolean> {
    const count = await this.prisma.transaction.count({
      where: { accountId, externalFingerprint: fingerprint },
    });
    return count > 0;
  }
}

export class PrismaCategoryRepository implements CategoryRepository {
  constructor(private readonly prisma: PrismaClient = getPrisma()) {}

  async create(category: Category): Promise<Category> {
    const row = await this.prisma.category.create({
      data: {
        id: category.id,
        userId: category.userId,
        parentId: category.parentId,
        name: category.name,
        kind: category.kind,
      },
    });
    return { ...row, kind: row.kind as CategoryKind };
  }

  async listForUser(userId: string): Promise<Category[]> {
    const rows = await this.prisma.category.findMany({
      where: { OR: [{ userId: null }, { userId }] },
      orderBy: { name: "asc" },
    });
    return rows.map((r) => ({ ...r, kind: r.kind as CategoryKind }));
  }
}

export class PrismaBudgetRepository implements BudgetRepository {
  constructor(private readonly prisma: PrismaClient = getPrisma()) {}

  async upsert(budget: Budget): Promise<Budget> {
    const row = await this.prisma.budget.upsert({
      where: {
        userId_categoryId_period: {
          userId: budget.userId,
          categoryId: budget.categoryId,
          period: budget.period,
        },
      },
      create: {
        id: budget.id,
        userId: budget.userId,
        categoryId: budget.categoryId,
        period: budget.period,
        limitMinor: budget.limit.amount,
        currency: budget.limit.currency,
        rollover: budget.rollover,
      },
      update: { limitMinor: budget.limit.amount, currency: budget.limit.currency, rollover: budget.rollover },
    });
    return {
      id: row.id,
      userId: row.userId,
      categoryId: row.categoryId,
      period: row.period,
      limit: Money.ofMinor(row.limitMinor, row.currency),
      rollover: row.rollover,
    };
  }

  async listByPeriod(userId: string, period: string): Promise<Budget[]> {
    const rows = await this.prisma.budget.findMany({ where: { userId, period } });
    return rows.map((row) => this.toBudget(row));
  }

  async listByUser(userId: string): Promise<Budget[]> {
    const rows = await this.prisma.budget.findMany({ where: { userId } });
    return rows.map((row) => this.toBudget(row));
  }

  private toBudget(row: {
    id: string;
    userId: string;
    categoryId: string;
    period: string;
    limitMinor: bigint;
    currency: string;
    rollover: boolean;
  }): Budget {
    return {
      id: row.id,
      userId: row.userId,
      categoryId: row.categoryId,
      period: row.period,
      limit: Money.ofMinor(row.limitMinor, row.currency),
      rollover: row.rollover,
    };
  }
}

export class PrismaAggregatorConnectionRepository implements AggregatorConnectionRepository {
  constructor(private readonly prisma: PrismaClient = getPrisma()) {}

  async create(c: AggregatorConnection): Promise<AggregatorConnection> {
    const row = await this.prisma.aggregatorConnection.create({
      data: {
        id: c.id,
        userId: c.userId,
        provider: c.provider,
        externalId: c.externalId,
        status: c.status,
        lastSyncedAt: c.lastSyncedAt ? new Date(c.lastSyncedAt) : null,
      },
    });
    return this.toConnection(row);
  }

  async findById(userId: string, id: string): Promise<AggregatorConnection | null> {
    const row = await this.prisma.aggregatorConnection.findFirst({ where: { id, userId } });
    return row ? this.toConnection(row) : null;
  }

  async listByUser(userId: string): Promise<AggregatorConnection[]> {
    const rows = await this.prisma.aggregatorConnection.findMany({ where: { userId } });
    return rows.map((r) => this.toConnection(r));
  }

  async update(c: AggregatorConnection): Promise<AggregatorConnection> {
    const row = await this.prisma.aggregatorConnection.update({
      where: { id: c.id },
      data: { status: c.status, lastSyncedAt: c.lastSyncedAt ? new Date(c.lastSyncedAt) : null },
    });
    return this.toConnection(row);
  }

  private toConnection(row: {
    id: string;
    userId: string;
    provider: string;
    externalId: string;
    status: string;
    lastSyncedAt: Date | null;
    createdAt: Date;
  }): AggregatorConnection {
    return {
      id: row.id,
      userId: row.userId,
      provider: row.provider as AggregatorProviderName,
      externalId: row.externalId,
      status: row.status as ConnectionStatus,
      lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

export class PrismaCategorizationRuleRepository implements CategorizationRuleRepository {
  constructor(private readonly prisma: PrismaClient = getPrisma()) {}

  async create(rule: CategorizationRule): Promise<CategorizationRule> {
    const row = await this.prisma.categorizationRule.create({
      data: { id: rule.id, userId: rule.userId, match: rule.match, categoryId: rule.categoryId },
    });
    return { id: row.id, userId: row.userId, match: row.match, categoryId: row.categoryId };
  }

  async listByUser(userId: string): Promise<CategorizationRule[]> {
    const rows = await this.prisma.categorizationRule.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => ({ id: r.id, userId: r.userId, match: r.match, categoryId: r.categoryId }));
  }
}

export class PrismaFxRateProvider implements FxRateProvider {
  constructor(private readonly prisma: PrismaClient = getPrisma()) {}

  async getRate(from: string, to: string, date: string): Promise<string> {
    const base = from.toUpperCase();
    const quote = to.toUpperCase();
    if (base === quote) return "1";
    const row = await this.prisma.fxRate.findFirst({
      where: { base, quote, date: { lte: toDbDate(date) } },
      orderBy: { date: "desc" },
    });
    if (!row) throw new Error(`No FX rate for ${base}->${quote} on or before ${date}`);
    return row.rate.toString();
  }
}
