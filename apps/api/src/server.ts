/**
 * MyMoney API — Fastify server.
 *
 * Phase 0: runs entirely on in-memory adapters (no database needed) so the
 * whole thing boots with `node dist/server.js` once dependencies are installed.
 * Swapping in the Prisma adapters later changes only the wiring below.
 *
 * Auth is a placeholder: the user id comes from an `x-user-id` header. Real
 * token-based auth is a deferred adapter (see PRD OQ / ARCHITECTURE §7).
 */

import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { Money } from "@mymoney/money-core";
import {
  InMemoryAccountRepository,
  InMemoryTransactionRepository,
  StaticFxRateProvider,
  SystemClock,
} from "./repositories/in-memory.js";
import { AppService, NotFoundError, ValidationError } from "./service.js";

// ---- Dependency wiring ------------------------------------------------------

const accounts = new InMemoryAccountRepository();
const transactions = new InMemoryTransactionRepository();
const service = new AppService(accounts, transactions, new StaticFxRateProvider(), new SystemClock());

// ---- Helpers ----------------------------------------------------------------

const serializeMoney = (m: Money) => ({
  amountMinor: m.amount.toString(),
  currency: m.currency,
  decimal: m.toDecimalString(),
});

function requireUser(req: FastifyRequest): string {
  const userId = req.headers["x-user-id"];
  if (typeof userId !== "string" || !userId) {
    throw new ValidationError(["Missing x-user-id header (placeholder auth)."]);
  }
  return userId;
}

// ---- Server -----------------------------------------------------------------

export function buildServer() {
  const app = Fastify({ logger: true });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ValidationError) return reply.status(400).send({ error: "validation", problems: err.problems });
    if (err instanceof NotFoundError) return reply.status(404).send({ error: "not_found", message: err.message });
    app.log.error(err);
    return reply.status(500).send({ error: "internal", message: "Unexpected error" });
  });

  app.get("/health", async () => ({ status: "ok", service: "mymoney-api", phase: 0 }));

  // Accounts
  app.post("/v1/accounts", async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = requireUser(req);
    const account = await service.createAccount(userId, req.body as never);
    return reply.status(201).send(serializeAccount(account));
  });

  app.get("/v1/accounts", async (req) => {
    const userId = requireUser(req);
    const list = await service.listAccounts(userId);
    return list.map(({ account, balance }) => ({
      ...serializeAccount(account),
      balance: serializeMoney(balance),
    }));
  });

  app.post("/v1/accounts/:id/archive", async (req) => {
    const userId = requireUser(req);
    const { id } = req.params as { id: string };
    return serializeAccount(await service.archiveAccount(userId, id));
  });

  // Transactions
  app.post("/v1/transactions", async (req, reply) => {
    const userId = requireUser(req);
    const txn = await service.createTransaction(userId, req.body as never);
    return reply.status(201).send(serializeTransaction(txn));
  });

  app.get("/v1/accounts/:id/transactions", async (req) => {
    const userId = requireUser(req);
    const { id } = req.params as { id: string };
    const q = req.query as { from?: string; to?: string; limit?: string; offset?: string };
    const txns = await service.listTransactions(userId, id, {
      from: q.from,
      to: q.to,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    });
    return txns.map(serializeTransaction);
  });

  app.delete("/v1/transactions/:id", async (req, reply) => {
    const userId = requireUser(req);
    const { id } = req.params as { id: string };
    await service.deleteTransaction(userId, id);
    return reply.status(204).send();
  });

  // Reports
  app.get("/v1/reports/net-worth", async (req) => {
    const userId = requireUser(req);
    const base = ((req.query as { base?: string }).base ?? "USD").toUpperCase();
    const nw = await service.netWorth(userId, base);
    return { base, netWorth: serializeMoney(nw) };
  });

  return app;
}

// ---- Serializers ------------------------------------------------------------

function serializeAccount(a: import("@mymoney/domain").Account) {
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    currency: a.currency,
    opening: serializeMoney(a.opening),
    openingDate: a.openingDate,
    archived: a.archivedAt !== null,
  };
}

function serializeTransaction(t: import("@mymoney/domain").Transaction) {
  return {
    id: t.id,
    accountId: t.accountId,
    date: t.date,
    amount: serializeMoney(t.amount),
    payee: t.payee,
    categoryId: t.categoryId,
    splits: t.splits.map((s) => ({ categoryId: s.categoryId, amount: serializeMoney(s.amount), note: s.note })),
    status: t.status,
    tags: t.tags,
    notes: t.notes ?? null,
  };
}

// ---- Boot -------------------------------------------------------------------

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.PORT ?? 3000);
  buildServer()
    .listen({ port, host: "0.0.0.0" })
    .then(() => console.log(`MyMoney API listening on :${port}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
