# MyMoney

A global, cloud personal-finance app in the spirit of **Microsoft Money** — recovering its planning depth, connecting to bank accounts in 50+ countries (not just North America), and adding multi-currency and intelligence the desktop era never had.

- **Product spec:** [docs/PRD.md](docs/PRD.md)
- **Platform architecture:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Monorepo layout

```
packages/
  money-core/   Zero-dependency money value type: integer minor units, exact FX,
                penny-safe allocation. The correctness-critical core. Fully tested.
  domain/       Entities, ledger rules, and ports (interfaces). Depends only on money-core.
apps/
  api/          Fastify HTTP API. Phase 0 runs on in-memory adapters (no DB needed);
                Prisma schema included for production persistence.
  web/          React client (not yet scaffolded — Phase 0.5).
docs/           PRD + architecture.
```

Dependency rule: `money-core` ← `domain` ← (`api`, `web`). Inner layers never import outer ones.

## Status

**Phase 0 — Foundation ledger: complete.** (50 tests passing, verified in Docker incl. a live Postgres integration run.)

- [x] `money-core`: Money type, currency registry, rounding modes, FX conversion, allocation — with a test suite incl. a randomized "no penny lost" property test.
- [x] `domain`: Account / Transaction / Category / Budget entities, derived-balance and net-worth rules, split validation, ports — with tests.
- [x] `api`: Fastify server; accounts, transactions, net-worth report. **Two interchangeable stores** behind the same domain ports — in-memory (default) and Prisma/Postgres.
- [x] Prisma adapters + `docker-compose` Postgres, verified by an integration test against a live database.
- [x] **CSV import** (mappable columns, inflow/outflow, dedupe), **budgets** (create + budget-vs-actual report), and **data export** (full JSON + transactions CSV).
- [ ] OFX/QFX import, web client, Phase 1 bank connectivity. (Next.)

### API endpoints (Phase 0)

```
POST   /v1/accounts                        GET  /v1/accounts
POST   /v1/accounts/:id/archive
POST   /v1/transactions                    GET  /v1/accounts/:id/transactions
DELETE /v1/transactions/:id
POST   /v1/transactions/import             # CSV import: { accountId, csv, hasHeader, mapping }
POST   /v1/budgets                         GET  /v1/budgets?period=YYYY-MM   # budget vs actual
GET    /v1/reports/net-worth?base=USD
GET    /v1/export[?format=csv]             # data ownership: full JSON, or transactions CSV
```

## Running it

> **This machine has no Node/npm installed and Docker Desktop is currently paused.**
> The commands below are the intended workflow. Pick **one** of the two setups.

### Option A — with Node installed (recommended)

Requires Node 20+ and pnpm (`npm i -g pnpm`).

```bash
pnpm install
pnpm test          # run every package's tests
pnpm build         # type-check + build all packages
pnpm dev:api       # start the API on http://localhost:3000 (in-memory, no DB)
```

Try the API (placeholder auth via `x-user-id`):

```bash
curl -s -XPOST localhost:3000/v1/accounts -H "x-user-id: u1" -H "content-type: application/json" \
  -d '{"name":"Everyday","type":"checking","currency":"EUR","openingBalance":"1000.00"}'

curl -s localhost:3000/v1/reports/net-worth?base=USD -H "x-user-id: u1"
```

### Persistence: in-memory vs. Postgres

The API runs on one of two interchangeable stores, selected by the `STORE` env
var. Both implement the same domain ports, so nothing else changes.

- `STORE=memory` (default) — no database; state lives in process memory.
- `STORE=postgres` — Prisma + PostgreSQL.

To use Postgres locally:

```bash
docker compose up -d db                       # start Postgres (localhost:5432)
cp apps/api/.env.example apps/api/.env         # DATABASE_URL is prefilled for this db
pnpm --filter @mymoney/api prisma:generate     # generate the Prisma client
pnpm --filter @mymoney/api prisma:push         # sync the schema to the database
STORE=postgres pnpm dev:api                    # run the API against Postgres
```

Run the Prisma integration test (skipped by default) against that database:

```bash
docker compose up -d db
RUN_DB_TESTS=1 DATABASE_URL="postgresql://mymoney:mymoney@localhost:5432/mymoney?schema=public" \
  pnpm --filter @mymoney/api test
```

### Option B — via Docker (no local Node)

Unpause Docker Desktop first, then from the repo root:

```bash
docker run --rm -v "$PWD":/app -w /app node:20-alpine sh -c "corepack enable && pnpm install && pnpm test"
```

## Design guarantees (why this is trustworthy)

- **No floats in the ledger.** Every amount is an integer count of minor units plus an explicit currency. Verified by tests.
- **Balances are derived, never stored.** An account balance is always opening + Σ(transactions); it cannot drift.
- **Splitting never loses a penny.** `Money.allocate` distributes remainders deterministically; a property test asserts the parts always sum back to the original across thousands of random cases.
- **Currencies never mix silently.** Cross-currency arithmetic throws unless you go through an explicit `convert`.
- **Providers are swappable.** Bank aggregators sit behind one `AggregationProvider` port, chosen per country — global reach is configuration, not a rewrite.
