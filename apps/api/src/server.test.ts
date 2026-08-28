import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";

/**
 * End-to-end API tests using Fastify's `inject` (no real socket). Each test uses
 * a distinct x-user-id so the shared in-memory store stays isolated per case.
 */
describe("MyMoney API", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = buildServer();
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
});
