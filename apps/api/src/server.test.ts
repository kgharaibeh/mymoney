import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";
import { AppService } from "./service.js";
import { ConnectionService } from "./connections.js";
import { AuthService } from "./auth.js";
import { AggregationRouter } from "./aggregation/router.js";
import { SandboxAggregationProvider } from "./aggregation/sandbox.js";
import {
  InMemoryAccountRepository,
  InMemoryAggregatorConnectionRepository,
  InMemoryBudgetRepository,
  InMemoryCategorizationRuleRepository,
  InMemoryCategoryRepository,
  InMemoryTransactionRepository,
  InMemoryUserRepository,
  StaticFxRateProvider,
  SystemClock,
} from "./repositories/in-memory.js";

/**
 * End-to-end API tests using Fastify's `inject` (no real socket). Each test
 * signs up a distinct user (via authFor) so the store stays isolated per case.
 */
describe("MyMoney API", () => {
  let app: FastifyInstance;

  /** Sign up (or log in) a user and return an Authorization header. */
  async function authFor(email: string): Promise<{ authorization: string }> {
    let res = await app.inject({ method: "POST", url: "/v1/auth/signup", payload: { email, password: "password123" } });
    if (res.statusCode === 409) {
      res = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password: "password123" } });
    }
    return { authorization: `Bearer ${res.json().token}` };
  }

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
    const auth = new AuthService(new InMemoryUserRepository(), "test-secret");
    app = buildServer(service, connections, auth);
    await app.ready();
  });

  it("reports health", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", phase: 1 });
  });

  it("rejects requests without a bearer token", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/accounts" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("auth");
  });

  it("rejects an invalid or tampered token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/accounts",
      headers: { authorization: "Bearer not.a.jwt" },
    });
    expect(res.statusCode).toBe(401);
  });

  describe("auth", () => {
    it("signs up, returns a token, and can fetch the current user", async () => {
      const signup = await app.inject({
        method: "POST",
        url: "/v1/auth/signup",
        payload: { email: "signup@test.com", password: "password123" },
      });
      expect(signup.statusCode).toBe(201);
      const token = signup.json().token as string;
      expect(signup.json().user.email).toBe("signup@test.com");

      const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${token}` } });
      expect(me.statusCode).toBe(200);
      expect(me.json().email).toBe("signup@test.com");
    });
    it("rejects a short password and a duplicate email", async () => {
      const short = await app.inject({
        method: "POST",
        url: "/v1/auth/signup",
        payload: { email: "x@test.com", password: "short" },
      });
      expect(short.statusCode).toBe(400);

      await app.inject({ method: "POST", url: "/v1/auth/signup", payload: { email: "dup@test.com", password: "password123" } });
      const dup = await app.inject({
        method: "POST",
        url: "/v1/auth/signup",
        payload: { email: "dup@test.com", password: "password123" },
      });
      expect(dup.statusCode).toBe(409);
    });
    it("logs in with correct credentials and rejects a wrong password", async () => {
      await app.inject({ method: "POST", url: "/v1/auth/signup", payload: { email: "login@test.com", password: "password123" } });
      const ok = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "login@test.com", password: "password123" } });
      expect(ok.statusCode).toBe(200);
      const wrong = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "login@test.com", password: "wrongpass1" } });
      expect(wrong.statusCode).toBe(401);
    });

    it("changing the password revokes existing tokens and issues a fresh one", async () => {
      const signup = await app.inject({
        method: "POST",
        url: "/v1/auth/signup",
        payload: { email: "changepw@test.com", password: "password123" },
      });
      const oldToken = signup.json().token as string;

      const changed = await app.inject({
        method: "POST",
        url: "/v1/auth/change-password",
        headers: { authorization: `Bearer ${oldToken}` },
        payload: { currentPassword: "password123", newPassword: "newpassword456" },
      });
      expect(changed.statusCode).toBe(200);
      const newToken = changed.json().token as string;

      // Old token is now revoked; the fresh one still works.
      const oldUse = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${oldToken}` } });
      expect(oldUse.statusCode).toBe(401);
      const newUse = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${newToken}` } });
      expect(newUse.statusCode).toBe(200);

      // The new password logs in; the old one no longer does.
      const relog = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "changepw@test.com", password: "newpassword456" } });
      expect(relog.statusCode).toBe(200);
    });

    it("rejects change-password with a wrong current password", async () => {
      const auth = await authFor("changepw2@test.com");
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/change-password",
        headers: auth,
        payload: { currentPassword: "not-it", newPassword: "newpassword456" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("log-out-everywhere revokes existing tokens", async () => {
      const signup = await app.inject({
        method: "POST",
        url: "/v1/auth/signup",
        payload: { email: "logoutall@test.com", password: "password123" },
      });
      const oldToken = signup.json().token as string;

      const res = await app.inject({ method: "POST", url: "/v1/auth/logout-all", headers: { authorization: `Bearer ${oldToken}` } });
      expect(res.statusCode).toBe(200);

      const oldUse = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${oldToken}` } });
      expect(oldUse.statusCode).toBe(401);
    });

    it("rate-limits repeated failed logins", async () => {
      await app.inject({ method: "POST", url: "/v1/auth/signup", payload: { email: "brute@test.com", password: "password123" } });
      let sawLimit = false;
      for (let i = 0; i < 12; i++) {
        const res = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "brute@test.com", password: "wrongpass1" } });
        if (res.statusCode === 429) {
          sawLimit = true;
          break;
        }
      }
      expect(sawLimit).toBe(true);
    });
  });

  it("creates an account, records a transaction, and derives the balance", async () => {
    const user = await authFor("a@test.com");

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
    const user = await authFor("b@test.com");
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
    const user = await authFor("c@test.com");
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
    const user = await authFor("d@test.com");
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
    const user = await authFor("e@test.com");
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
    const user = await authFor("d@test.com"); // reuse the CSV-import user

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
    const user = await authFor("bank@test.com");

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
