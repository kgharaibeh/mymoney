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
import fastifyStatic from "@fastify/static";
import type { Money } from "@mymoney/money-core";
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
import { AppService, NotFoundError, ValidationError } from "./service.js";
import { ConnectionService } from "./connections.js";
import { AuthError, AuthService } from "./auth.js";
import { AggregationRouter } from "./aggregation/router.js";
import { SandboxAggregationProvider } from "./aggregation/sandbox.js";
import { SaltEdgeAggregationProvider } from "./aggregation/saltedge.js";
import type { AggregationProvider, Clock } from "@mymoney/domain";

export interface AppDeps {
  service: AppService;
  connections: ConnectionService;
  auth: AuthService;
}

// ---- Dependency wiring ------------------------------------------------------

/**
 * Choose a persistence store from the environment. `STORE=postgres` uses the
 * Prisma adapters (imported lazily so the in-memory path needs no generated
 * Prisma client); anything else uses the in-memory adapters.
 */
/** Register the aggregation providers: specific first, Salt Edge as the "*" fallback. */
function buildRouter(): AggregationRouter {
  const providers: AggregationProvider[] = [new SandboxAggregationProvider()];
  const saltEdge = SaltEdgeAggregationProvider.fromEnv();
  if (saltEdge) providers.push(saltEdge); // only if credentials are configured
  return new AggregationRouter(providers);
}

function authSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    console.warn("[auth] AUTH_SECRET is not set — using an insecure dev default. Set it in production.");
    return "dev-insecure-secret-change-me";
  }
  return secret;
}

export async function createDepsFromEnv(): Promise<AppDeps> {
  const clock: Clock = new SystemClock();
  const router = buildRouter();

  if ((process.env.STORE ?? "memory").toLowerCase() === "postgres") {
    const {
      PrismaAccountRepository,
      PrismaTransactionRepository,
      PrismaBudgetRepository,
      PrismaCategoryRepository,
      PrismaAggregatorConnectionRepository,
      PrismaCategorizationRuleRepository,
      PrismaUserRepository,
      PrismaFxRateProvider,
    } = await import("./repositories/prisma.js");
    const accounts = new PrismaAccountRepository();
    const transactions = new PrismaTransactionRepository();
    const service = new AppService(
      accounts,
      transactions,
      new PrismaBudgetRepository(),
      new PrismaCategoryRepository(),
      new PrismaFxRateProvider(),
      clock,
    );
    const connections = new ConnectionService(
      accounts,
      transactions,
      new PrismaAggregatorConnectionRepository(),
      new PrismaCategorizationRuleRepository(),
      router,
      clock,
    );
    const auth = new AuthService(new PrismaUserRepository(), authSecret());
    return { service, connections, auth };
  }

  // In-memory: account & transaction repos are SHARED by both services so that
  // accounts created during a bank sync are visible to the rest of the API.
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
    router,
    clock,
  );
  const auth = new AuthService(new InMemoryUserRepository(), authSecret());
  return { service, connections, auth };
}

// ---- Helpers ----------------------------------------------------------------

const serializeMoney = (m: Money) => ({
  amountMinor: m.amount.toString(),
  currency: m.currency,
  decimal: m.toDecimalString(),
});

/** The authenticated user id, set on the request by the auth hook. */
function requireUser(req: FastifyRequest): string {
  const userId = (req as FastifyRequest & { userId?: string }).userId;
  if (!userId) throw new AuthError(401, "Not authenticated.");
  return userId;
}

// ---- Server -----------------------------------------------------------------

const PUBLIC_V1_PATHS = new Set(["/v1/auth/signup", "/v1/auth/login"]);

export function buildServer(service: AppService, connections: ConnectionService, auth: AuthService) {
  const app = Fastify({ logger: true });

  // In production the API also serves the built web app as static files, so the
  // whole thing is one deployable service. Set WEB_DIST to the web `dist` dir.
  const webDist = process.env.WEB_DIST;
  if (webDist) {
    app.register(fastifyStatic, { root: webDist, prefix: "/" });
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AuthError) return reply.status(err.status).send({ error: "auth", message: err.message });
    if (err instanceof ValidationError) return reply.status(400).send({ error: "validation", problems: err.problems });
    if (err instanceof NotFoundError) return reply.status(404).send({ error: "not_found", message: err.message });
    // Respect Fastify's own client-error status codes (e.g. malformed body).
    if (typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: "bad_request", message: err.message });
    }
    app.log.error(err);
    return reply.status(500).send({ error: "internal", message: "Unexpected error" });
  });

  // Baseline security response headers.
  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
  });

  // Authenticate every /v1 request except the public auth endpoints. Health and
  // the static web assets (any non-/v1 path) are open. A valid, unrevoked bearer
  // token sets req.userId, which requireUser() reads.
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0];
    if (!path.startsWith("/v1")) return;
    if (PUBLIC_V1_PATHS.has(path)) return;
    const header = req.headers["authorization"];
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return reply.status(401).send({ error: "auth", message: "Missing bearer token." });
    try {
      const { userId } = await auth.authenticate(token);
      (req as FastifyRequest & { userId?: string }).userId = userId;
    } catch {
      return reply.status(401).send({ error: "auth", message: "Invalid or expired token." });
    }
  });

  app.get("/health", async () => ({ status: "ok", service: "mymoney-api", phase: 1 }));

  // Auth
  app.post("/v1/auth/signup", async (req, reply) => {
    const result = await auth.signup(req.body as never);
    return reply.status(201).send(result);
  });
  app.post("/v1/auth/login", async (req) => auth.login(req.body as never));
  app.get("/v1/auth/me", async (req) => auth.me(requireUser(req)));
  app.post("/v1/auth/change-password", async (req) => {
    const body = req.body as { currentPassword?: string; newPassword?: string };
    return auth.changePassword(requireUser(req), body.currentPassword ?? "", body.newPassword ?? "");
  });
  app.post("/v1/auth/logout-all", async (req) => auth.logoutEverywhere(requireUser(req)));

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

  // Import
  app.post("/v1/transactions/import", async (req) => {
    const userId = requireUser(req);
    return service.importCsv(userId, req.body as never);
  });

  // Budgets
  app.post("/v1/budgets", async (req, reply) => {
    const userId = requireUser(req);
    const budget = await service.createBudget(userId, req.body as never);
    return reply.status(201).send(serializeBudget(budget));
  });

  app.get("/v1/budgets", async (req) => {
    const userId = requireUser(req);
    const period = (req.query as { period?: string }).period;
    if (!period) throw new ValidationError(["Query parameter `period` (YYYY-MM) is required."]);
    const lines = await service.budgetReport(userId, period);
    return lines.map((l) => ({
      ...serializeBudget(l.budget),
      spent: serializeMoney(l.spent),
      remaining: serializeMoney(l.remaining),
    }));
  });

  // Reports
  app.get("/v1/reports/net-worth", async (req) => {
    const userId = requireUser(req);
    const base = ((req.query as { base?: string }).base ?? "USD").toUpperCase();
    const nw = await service.netWorth(userId, base);
    return { base, netWorth: serializeMoney(nw) };
  });

  // Bank connectivity (Phase 1)
  app.post("/v1/connections", async (req, reply) => {
    const userId = requireUser(req);
    const { connection, redirectUrl } = await connections.startConnection(userId, req.body as never);
    return reply.status(201).send({ ...serializeConnection(connection), redirectUrl });
  });

  app.get("/v1/connections", async (req) => {
    const userId = requireUser(req);
    return (await connections.listConnections(userId)).map(serializeConnection);
  });

  app.post("/v1/connections/:id/sync", async (req) => {
    const userId = requireUser(req);
    const { id } = req.params as { id: string };
    return connections.syncConnection(userId, id);
  });

  app.post("/v1/connections/:id/revoke", async (req) => {
    const userId = requireUser(req);
    const { id } = req.params as { id: string };
    return serializeConnection(await connections.revokeConnection(userId, id));
  });

  // Auto-categorization rules
  app.post("/v1/rules", async (req, reply) => {
    const userId = requireUser(req);
    const rule = await connections.addRule(userId, req.body as never);
    return reply.status(201).send(rule);
  });

  app.get("/v1/rules", async (req) => {
    const userId = requireUser(req);
    return connections.listRules(userId);
  });

  // Export (data ownership)
  app.get("/v1/export", async (req, reply) => {
    const userId = requireUser(req);
    const format = (req.query as { format?: string }).format ?? "json";
    if (format === "csv") {
      const csv = await service.transactionsCsv(userId);
      return reply.header("content-type", "text/csv; charset=utf-8").send(csv);
    }
    const data = await service.exportAll(userId);
    return {
      exportedAt: new Date().toISOString(),
      accounts: data.accounts.map(serializeAccount),
      transactions: data.transactions.map(serializeTransaction),
      budgets: data.budgets.map(serializeBudget),
      categories: data.categories,
    };
  });

  // SPA fallback: any unmatched GET that isn't an API/health route returns the
  // web app's index.html so client-side rendering can take over.
  app.setNotFoundHandler((req, reply) => {
    if (webDist && req.method === "GET" && !req.url.startsWith("/v1") && !req.url.startsWith("/health")) {
      return reply.sendFile("index.html");
    }
    return reply.status(404).send({ error: "not_found", message: "Route not found" });
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

function serializeConnection(c: import("@mymoney/domain").AggregatorConnection) {
  return {
    id: c.id,
    provider: c.provider,
    status: c.status,
    lastSyncedAt: c.lastSyncedAt ?? null,
    createdAt: c.createdAt,
  };
}

function serializeBudget(b: import("@mymoney/domain").Budget) {
  return {
    id: b.id,
    categoryId: b.categoryId,
    period: b.period,
    limit: serializeMoney(b.limit),
    rollover: b.rollover,
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
  createDepsFromEnv()
    .then((deps) => buildServer(deps.service, deps.connections, deps.auth).listen({ port, host: "0.0.0.0" }))
    .then(() => console.log(`MyMoney API listening on :${port} (store: ${process.env.STORE ?? "memory"})`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
