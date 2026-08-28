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

**Phase 0 — Foundation ledger, in progress.**

- [x] `money-core`: Money type, currency registry, rounding modes, FX conversion, allocation — with a test suite incl. a randomized "no penny lost" property test.
- [x] `domain`: Account / Transaction / Category / Budget entities, derived-balance and net-worth rules, split validation, ports — with tests.
- [x] `api`: Fastify server on in-memory adapters; accounts, transactions, net-worth report. Prisma schema for Postgres.
- [ ] CSV / OFX import, budgets endpoints, full export, web client. (Next.)

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
