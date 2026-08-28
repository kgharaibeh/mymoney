import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AppService } from "../service.js";
import {
  getPrisma,
  disconnectPrisma,
  PrismaAccountRepository,
  PrismaTransactionRepository,
  PrismaBudgetRepository,
  PrismaCategoryRepository,
  PrismaFxRateProvider,
} from "./prisma.js";
import { SystemClock } from "./in-memory.js";

/**
 * Integration test against a real Postgres. It is SKIPPED unless RUN_DB_TESTS=1
 * and DATABASE_URL are set, so the everyday `pnpm test` stays database-free.
 *
 * Run it with: docker compose up -d db && (prisma db push) && RUN_DB_TESTS=1 pnpm --filter @mymoney/api test
 */
const run = process.env.RUN_DB_TESTS === "1";

describe.skipIf(!run)("Prisma adapters (Postgres)", () => {
  const prisma = getPrisma();
  const userId = "itest-user";
  let service: AppService;

  beforeAll(async () => {
    // Clean slate for a deterministic run.
    await prisma.transactionSplit.deleteMany({});
    await prisma.transaction.deleteMany({});
    await prisma.account.deleteMany({});
    await prisma.budget.deleteMany({});
    await prisma.category.deleteMany({});
    await prisma.fxRate.deleteMany({});
    await prisma.user.deleteMany({ where: { id: userId } });

    // Seed the FK dependencies the relational store requires.
    await prisma.user.create({ data: { id: userId, email: "itest@example.com" } });
    await prisma.category.createMany({
      data: [
        { id: "food", userId, name: "Food", kind: "expense" },
        { id: "tip", userId, name: "Tips", kind: "expense" },
      ],
    });
    await prisma.fxRate.create({
      data: { base: "EUR", quote: "USD", date: new Date("2026-01-01T00:00:00Z"), rate: "1.08" },
    });

    service = new AppService(
      new PrismaAccountRepository(),
      new PrismaTransactionRepository(),
      new PrismaBudgetRepository(),
      new PrismaCategoryRepository(),
      new PrismaFxRateProvider(),
      new SystemClock(),
    );
  });

  afterAll(async () => {
    await disconnectPrisma();
  });

  it("persists an account and derives its balance from transactions", async () => {
    const account = await service.createAccount(userId, {
      name: "Everyday",
      type: "checking",
      currency: "EUR",
      openingBalance: "1000.00",
    });
    await service.createTransaction(userId, {
      accountId: account.id,
      date: "2026-02-01",
      amount: "-10.00",
      payee: "Coffee",
      categoryId: "food",
    });

    const list = await service.listAccounts(userId);
    const everyday = list.find((x) => x.account.id === account.id)!;
    expect(everyday.balance.toDecimalString()).toBe("990.00");
  });

  it("round-trips a split transaction with lines that sum to the total", async () => {
    const account = await service.createAccount(userId, {
      name: "Dining",
      type: "cash",
      currency: "EUR",
      openingBalance: "0.00",
    });
    const txn = await service.createTransaction(userId, {
      accountId: account.id,
      date: "2026-02-02",
      amount: "-30.00",
      payee: "Dinner",
      splits: [
        { categoryId: "food", amount: "-20.00" },
        { categoryId: "tip", amount: "-10.00" },
      ],
    });
    expect(txn.splits).toHaveLength(2);

    const reread = await new PrismaTransactionRepository().findById(userId, txn.id);
    expect(reread?.splits.map((s) => s.amount.toDecimalString())).toEqual(["-20.00", "-10.00"]);
  });

  it("computes multi-currency net worth using a stored FX rate", async () => {
    // The EUR balances above (990.00 + 0.00 - 30.00 = 960.00) convert at 1.08.
    const nw = await service.netWorth(userId, "USD");
    expect(nw.currency).toBe("USD");
    // 960.00 EUR * 1.08 = 1036.80 USD
    expect(nw.toDecimalString()).toBe("1036.80");
  });
});
