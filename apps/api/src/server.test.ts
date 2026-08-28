import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";
import { AppService } from "./service.js";
import { ConnectionService } from "./connections.js";
import { AggregationRouter } from "./aggregation/router.js";
import { SandboxAggregationProvider } from "./aggregation/sandbox.js";
import {
  InMemoryAccountRepository,
  InMemoryAggregatorConnectionRepository,
  InMemoryBudgetRepository,
  InMemoryCategorizationRuleRepository,
  InMemoryCategoryRepository,
  InMemoryTransactionRepository,
  StaticFxRateProvider,
  SystemClock,
} from "./repositories/in-memory.js";

/**
 * End-to-end API tests using Fastify's `inject` (no real socket). Each test uses
 * a distinct x-user-id so the in-memory store stays isolated per case.
 */
describe("MyMoney API", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const clock = new SystemClock();
    // Shared repos so bank-synced accounts are visible to the rest of the API.
    const accounts = new InMemoryAccountRepository();
    const transactions = new InMemoryTransactionRepository();
    const service = new AppService(
      accounts,
      transactions,
      new InMemoryBudgetRepository(),
      new InMemoryCategoryRepository(),
      new StaticFxRateProvider(),
      clock,
    );
    const connections = new ConnectionService(
      accounts,
      transactions,
      new InMemoryAggregatorConnectionRepository(),
      new InMemoryCategorizationRuleRepository(),
      new AggregationRouter([new SandboxAggregationProvider()]),
      clock,
    );
    app = buildServer(service, connections);
    await app.ready();
  });

  it("reports health", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", phase: 0 });
  });

  it("rejects requests without placeholder auth", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/accounts" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation");
  });

  it("creates an account, records a transaction, and derives the balance", async () => {
    const user = { "x-user-id": "user-a" };

    const created = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: user,
      payload: { name: "Everyday", type: "checking", currency: "EUR", openingBalance: "1000.00" },
    });
    expect(created.statusCode).toBe(201);
    const accountId = created.json().id as string;
    expect(created.json().opening.decimal).toBe("1000.00");

    const txn = await app.inject({
      method: "POST",
      url: "/v1/transactions",
      headers: user,
      payload: { accountId, date: "2026-02-01", amount: "-10.00", payee: "Coffee", categoryId: "food" },
    });
    expect(txn.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: "/v1/accounts", headers: user });
    expect(list.statusCode).toBe(200);
    const accounts = list.json() as Array<{ id: string; balance: { decimal: string } }>;
    const everyday = accounts.find((a) => a.id === accountId)!;
    expect(everyday.balance.decimal).toBe("990.00");
  });

  it("rejects a split that does not sum to the total", async () => {
    const user = { "x-user-id": "user-b" };
    const account = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: user,
      payload: { name: "Cash", type: "cash", currency: "USD" },
    });
    const accountId = account.json().id as string;

    const bad = await app.inject({
      method: "POST",
      url: "/v1/transactions",
      headers: user,
      payload: {
        accountId,
        date: "2026-02-02",
        amount: "-30.00",
        payee: "Dinner",
        splits: [
          { categoryId: "food", amount: "-20.00" },
          { categoryId: "tip", amount: "-9.00" }, // 1.00 short on purpose
        ],
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().problems[0]).toContain("Split lines sum to");
  });

  it("computes multi-currency net worth in a base currency", async () => {
    const user = { "x-user-id": "user-c" };
    // 990.00 EUR at EUR->USD 1.08 = 1069.20 USD
    const acct = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: user,
      payload: { name: "Euro savings", type: "savings", currency: "EUR", openingBalance: "990.00" },
    });
    expect(acct.statusCode).toBe(201);

    const nw = await app.inject({ method: "GET", url: "/v1/reports/net-worth?base=USD", headers: user });
    expect(nw.statusCode).toBe(200);
    expect(nw.json()).toMatchObject({ base: "USD", netWorth: { currency: "USD", decimal: "1069.20" } });
  });

  it("imports a CSV, derives the balance, and dedupes on re-import", async () => {
    const user = { "x-user-id": "user-d" };
    const account = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: user,
      payload: { name: "Import target", type: "checking", currency: "USD", openingBalance: "100.00" },
    });
    const accountId = account.json().id as string;

    const csv = ["Date,Description,Amount", "2026-05-01,Coffee,-3.50", "2026-05-02,Groceries,-20.00"].join("\n");
    const mapping = { date: "Date", payee: "Description", amount: "Amount" };

    const first = await app.inject({
      method: "POST",
      url: "/v1/transactions/import",
      headers: user,
      payload: { accountId, csv, hasHeader: true, mapping },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ imported: 2, skippedDuplicates: 0, errors: [] });

    const list = await app.inject({ method: "GET", url: "/v1/accounts", headers: user });
    const acct = (list.json() as Array<{ id: string; balance: { decimal: string } }>).find((a) => a.id === accountId)!;
    expect(acct.balance.decimal).toBe("76.50"); // 100 - 3.50 - 20.00

    const again = await app.inject({
      method: "POST",
      url: "/v1/transactions/import",
      headers: user,
      payload: { accountId, csv, hasHeader: true, mapping },
    });
    expect(again.json()).toMatchObject({ imported: 0, skippedDuplicates: 2 });
  });

  it("reports budget vs. actual for a period", async () => {
    const user = { "x-user-id": "user-e" };
    const account = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: user,
      payload: { name: "Spending", type: "checking", currency: "USD", openingBalance: "0.00" },
    });
    const accountId = account.json().id as string;

    const add = (date: string, amount: string, categoryId: string) =>
      app.inject({
        method: "POST",
        url: "/v1/transactions",
        headers: user,
        payload: { accountId, date, amount, payee: "x", categoryId },
      });
    await add("2026-05-10", "-30.00", "food");
    await add("2026-05-11", "-20.00", "food");
    await add("2026-05-01", "-500.00", "housing"); // different category, ignored

    const created = await app.inject({
      method: "POST",
      url: "/v1/budgets",
      headers: user,
      payload: { categoryId: "food", period: "2026-05", limit: "100.00", currency: "USD" },
    });
    expect(created.statusCode).toBe(201);

    const report = await app.inject({ method: "GET", url: "/v1/budgets?period=2026-05", headers: user });
    expect(report.statusCode).toBe(200);
    const food = (report.json() as Array<{ categoryId: string; spent: { decimal: string }; remaining: { decimal: string } }>).find(
      (b) => b.categoryId === "food",
    )!;
    expect(food.spent.decimal).toBe("50.00");
    expect(food.remaining.decimal).toBe("50.00");
  });

  it("exports all data as JSON and transactions as CSV", async () => {
    const user = { "x-user-id": "user-d" }; // reuse the CSV-import user

    const json = await app.inject({ method: "GET", url: "/v1/export", headers: user });
    expect(json.statusCode).toBe(200);
    const body = json.json() as { accounts: unknown[]; transactions: unknown[] };
    expect(body.accounts.length).toBeGreaterThan(0);
    expect(body.transactions.length).toBe(2);

    const csv = await app.inject({ method: "GET", url: "/v1/export?format=csv", headers: user });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\n")[0]).toBe("date,account,payee,amount,currency,category,status");
  });

  it("links a bank via the sandbox provider, syncs, auto-categorizes, and dedupes", async () => {
    const user = { "x-user-id": "user-bank" };

    // A categorization rule that should tag the imported Starbucks transaction.
    const rule = await app.inject({
      method: "POST",
      url: "/v1/rules",
      headers: user,
      payload: { match: "starbucks", categoryId: "coffee" },
    });
    expect(rule.statusCode).toBe(201);

    const connect = await app.inject({
      method: "POST",
      url: "/v1/connections",
      headers: user,
      payload: { country: "SANDBOX" },
    });
    expect(connect.statusCode).toBe(201);
    expect(connect.json().provider).toBe("sandbox");
    expect(connect.json().redirectUrl).toContain("sandbox");
    const connectionId = connect.json().id as string;

    const sync = await app.inject({ method: "POST", url: `/v1/connections/${connectionId}/sync`, headers: user });
    expect(sync.statusCode).toBe(200);
    expect(sync.json()).toEqual({ accountsLinked: 2, imported: 4, skippedDuplicates: 0 });

    // The linked checking account's derived balance matches the bank balance.
    const accounts = (await app.inject({ method: "GET", url: "/v1/accounts", headers: user })).json() as Array<{
      id: string;
      name: string;
      balance: { decimal: string };
    }>;
    const checking = accounts.find((a) => a.name === "Sandbox Checking")!;
    expect(checking.balance.decimal).toBe("1937.66");

    // The Starbucks transaction was auto-categorized.
    const txns = (
      await app.inject({ method: "GET", url: `/v1/accounts/${checking.id}/transactions`, headers: user })
    ).json() as Array<{ payee: string; categoryId: string | null }>;
    const coffee = txns.find((t) => t.payee.includes("STARBUCKS"))!;
    expect(coffee.categoryId).toBe("coffee");

    // Re-syncing imports nothing new (incremental cursor + fingerprint dedupe).
    const resync = await app.inject({ method: "POST", url: `/v1/connections/${connectionId}/sync`, headers: user });
    expect(resync.json()).toEqual({ accountsLinked: 0, imported: 0, skippedDuplicates: 0 });
  });
});
