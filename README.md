# MyMoney

[![CI](https://github.com/kgharaibeh/mymoney/actions/workflows/ci.yml/badge.svg)](https://github.com/kgharaibeh/mymoney/actions/workflows/ci.yml)

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
  api/          Fastify HTTP API. Runs on in-memory adapters (no DB needed) or Prisma/Postgres.
  web/          React + Vite client. Reuses @mymoney/money-core for money formatting.
docs/           PRD + architecture.
```

Dependency rule: `money-core` ← `domain` ← (`api`, `web`). Inner layers never import outer ones.

## Status

**Phase 0 complete; Phase 1 (bank connectivity) landed.** (56 tests passing, verified in Docker incl. a live Postgres integration run.)

- [x] `money-core`: Money type, currency registry, rounding modes, FX conversion, allocation — with a test suite incl. a randomized "no penny lost" property test.
- [x] `domain`: Account / Transaction / Category / Budget entities, derived-balance and net-worth rules, split validation, rule-based categorization, ports — with tests.
- [x] `api`: Fastify server. **Two interchangeable stores** behind the same domain ports — in-memory (default) and Prisma/Postgres.
- [x] Prisma adapters + `docker-compose` Postgres, verified by integration tests against a live database.
- [x] **Phase 0:** CSV import (mappable columns, inflow/outflow, dedupe), budgets (create + budget-vs-actual), and data export (full JSON + transactions CSV).
- [x] **Phase 1:** aggregation layer — `AggregationProvider` port with a **Sandbox provider** (runs offline) and a real **Salt Edge** adapter, an `AggregationRouter` that picks a provider per country, a **sync engine** (account linking, incremental pull, fingerprint dedupe, consistent opening balances), and **auto-categorization rules**.
- [x] **Web client:** React + Vite SPA over the whole API — Dashboard (net worth), Accounts (register, add, CSV import), Budgets, and Banks (link/sync/rules).
- [x] **Auth:** email/password signup + login, scrypt-hashed passwords, HS256 bearer tokens (zero external deps); every `/v1` route requires a token; the web client has a login/signup gate.
- [x] **Auth hardening:** token revocation via a per-user version (change-password and log-out-everywhere invalidate all outstanding tokens), per-request user-existence checks, login rate limiting, and baseline security headers.
- [x] **Web polish:** toasts, loading spinners, inline confirm for destructive actions, delete-transaction, archive-account, a Settings view (change password, sign out everywhere), and session validation on load.
- [ ] OFX/QFX import, Phase 2 intelligence. (Next.)

### API endpoints

```
POST   /v1/auth/signup                     # { email, password } -> { token, user }
POST   /v1/auth/login                      GET  /v1/auth/me
POST   /v1/auth/change-password            POST /v1/auth/logout-all

POST   /v1/accounts                        GET  /v1/accounts
POST   /v1/accounts/:id/archive
POST   /v1/transactions                    GET  /v1/accounts/:id/transactions
DELETE /v1/transactions/:id
POST   /v1/transactions/import             # CSV import: { accountId, csv, hasHeader, mapping }
POST   /v1/budgets                         GET  /v1/budgets?period=YYYY-MM   # budget vs actual
GET    /v1/reports/net-worth?base=USD
GET    /v1/export[?format=csv]             # data ownership: full JSON, or transactions CSV

# Phase 1 — bank connectivity
POST   /v1/connections                     # { country } -> picks a provider, returns redirectUrl
GET    /v1/connections
POST   /v1/connections/:id/sync            # discover accounts, pull + dedupe + auto-categorize
POST   /v1/connections/:id/revoke
POST   /v1/rules                           # { match, categoryId }  auto-categorization rule
GET    /v1/rules
```

### Bank connectivity notes

- The **Sandbox provider** (`country: "SANDBOX"`) is a deterministic fake bank, so the full connect → sync → categorize flow runs with no credentials — used by the tests and handy for local dev.
- The **Salt Edge** adapter activates only when `SALT_EDGE_APP_ID` / `SALT_EDGE_SECRET` are set; it registers as the global (`*`) fallback in the router. Its API field names follow Salt Edge v6 and should be re-verified against current docs before production.

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

### The web client

The React client (in `apps/web`) talks to the API and reuses `@mymoney/money-core`
for formatting. In dev it proxies `/v1` to the API, so run both:

```bash
pnpm -r build              # build money-core first (the web app imports it)
pnpm dev:api               # terminal 1 — API on :3000 (in-memory)
pnpm --filter @mymoney/web dev   # terminal 2 — web on http://localhost:5173
```

Then open http://localhost:5173. The Dashboard shows net worth and accounts;
**Banks** links a Sandbox bank and syncs it (with auto-categorization rules);
**Accounts** has the register, add-transaction, and CSV import; **Budgets**
tracks budget-vs-actual. You sign up / log in first; the session is a bearer
token kept in the browser.

Try the API (real auth — sign up, then use the returned bearer token):

```bash
TOKEN=$(curl -s -XPOST localhost:3000/v1/auth/signup -H "content-type: application/json" \
  -d '{"email":"you@example.com","password":"password123"}' | jq -r .token)

curl -s -XPOST localhost:3000/v1/accounts -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"name":"Everyday","type":"checking","currency":"EUR","openingBalance":"1000.00"}'

curl -s localhost:3000/v1/reports/net-worth?base=USD -H "authorization: Bearer $TOKEN"
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
