# MyMoney — Platform Architecture

**Status:** Draft v0.2 · **Companion to:** [PRD.md](./PRD.md)

---

## 1. Architectural principles

1. **One core, many clients.** The correctness-critical logic (money math, ledger rules, planning formulas) lives in shared, framework-free packages reused by web, mobile, and server. Write it once, test it once, trust it everywhere.
2. **Providers behind an interface.** Every bank aggregator (Salt Edge, Tink, Plaid, TrueLayer) sits behind a single `AggregationProvider` port. Choosing a provider per country is configuration, not code change.
3. **The ledger is derived, never mutated.** Balances are computed from transactions. There is no "balance" column that code can accidentally desync.
4. **Money is never a float.** All amounts are integer minor units + an explicit ISO-4217 currency, handled exclusively through `money-core`.
5. **Offline-first clients.** Clients hold a local cache and a mutation queue; the server is the system of record but the app works without it.
6. **Ports & adapters (hexagonal).** Domain logic depends on interfaces; databases, HTTP, and third-party SDKs are swappable adapters at the edges.

---

## 2. System context (C4 level 1)

```
                    ┌─────────────────────────────────────────────┐
                    │                  MyMoney                     │
   ┌──────────┐     │  ┌──────────┐   ┌──────────┐   ┌──────────┐ │
   │  User    │────▶│  │  Clients │──▶│   API    │──▶│  Domain  │ │
   │ (web/    │     │  │ web/iOS/ │   │ (Fastify)│   │ services │ │
   │  mobile) │◀────│  │ Android  │◀──│          │◀──│ + core   │ │
   └──────────┘     │  └──────────┘   └────┬─────┘   └────┬─────┘ │
                    │                      │              │       │
                    │              ┌───────▼──────┐  ┌────▼─────┐ │
                    │              │ Aggregation  │  │ Postgres │ │
                    │              │   adapter    │  │  + FX    │ │
                    │              └───────┬──────┘  └──────────┘ │
                    └──────────────────────┼────────────────────-─┘
                                           │
              ┌────────────────────────────┼───────────────────────────┐
              ▼               ▼             ▼              ▼             ▼
         ┌─────────┐    ┌─────────┐   ┌─────────┐    ┌─────────┐  ┌─────────┐
         │Salt Edge│    │  Tink   │   │  Plaid  │    │TrueLayer│  │ FX rate │
         │ (global)│    │(Europe) │   │ (US/CA) │    │ (UK/EU) │  │  feed   │
         └─────────┘    └─────────┘   └─────────┘    └─────────┘  └─────────┘
```

External systems are all reached through adapters; none of their SDK types leak into the domain.

---

## 3. Component architecture (C4 level 2)

### Monorepo layout
```
mymoney/
├── packages/
│   ├── money-core/     # Framework-free. Integer money, currency, FX, allocation. Zero deps.
│   └── domain/         # Entities, value objects, ledger rules, ports (interfaces). Depends only on money-core.
├── apps/
│   ├── api/            # Fastify HTTP API. Adapters: Prisma repos, aggregation providers, auth.
│   └── web/            # React + Vite client (Phase 0.5+).
└── docs/               # PRD, this document.
```
Dependency rule (enforced by design): `money-core` ← `domain` ← (`api`, `web`). Inner layers never import outer ones.

### Layers

| Layer | Responsibility | Depends on | Never depends on |
|---|---|---|---|
| **money-core** | Money value type, currency registry, rounding, allocation, FX conversion | nothing | domain, frameworks |
| **domain** | Entities (Account, Transaction, Category, Budget), ledger invariants, service logic, **ports** | money-core | Fastify, Prisma, provider SDKs |
| **api / adapters** | HTTP transport, persistence (Prisma), aggregation providers, auth, jobs | domain, money-core | — |
| **clients** | UI, offline cache, mutation queue | (talks to API over HTTP) | server internals |

### Ports (interfaces the domain defines, adapters implement)
- `AccountRepository`, `TransactionRepository`, `CategoryRepository`, `BudgetRepository`
- `FxRateProvider` — dated rates for a currency pair
- `AggregationProvider` — connect, list accounts, fetch transactions, handle consent/webhooks
- `Clock` — injectable time source (deterministic tests)

---

## 4. The aggregation adapter (the strategic core)

This is the single most important early investment. It makes "any bank account, globally" a routing choice.

```
        Domain / API
             │  connect(country, institution, userConsent)
             ▼
   ┌───────────────────────┐
   │  AggregationRouter     │   picks a provider by (country, institution, capability)
   └───────────┬───────────┘
               │  one normalized interface: AggregationProvider
   ┌───────────┼───────────┬───────────────┐
   ▼           ▼           ▼               ▼
SaltEdge   TinkAdapter  PlaidAdapter  TrueLayerAdapter
Adapter
   │           │           │               │
   └───────────┴─────┬─────┴───────────────┘
                     ▼
        Normalizer → canonical Transaction / Account model
                     ▼
        Dedupe + transfer-pair detection → domain
```

- **Routing policy:** a table keyed by country (and optionally institution) selects the provider. Salt Edge is the broad default; Europe may prefer Tink/TrueLayer; North America prefers Plaid.
- **Normalization:** every provider's payload maps to one canonical shape before it touches the domain. Provider quirks stay in the adapter.
- **Consent lifecycle:** connect → active → needs-reconsent → revoked, with health checks and webhooks handled per-adapter but surfaced uniformly.
- **Idempotency & dedupe:** imported transactions are matched on a stable fingerprint (provider id + amount + date + normalized payee) so re-syncs never duplicate.

---

## 5. Data model (Phase 0 core)

Money columns are stored as **two columns**: `amount_minor` (BIGINT, integer minor units) + `currency` (CHAR(3)). Never a float, never a single "amount" number.

```
User ──< Account ──< Transaction ──< TransactionSplit
                          │
                          └── transfer_group_id (links the two legs of a transfer)

Category (self-referencing: parent_id)  ──< Transaction / TransactionSplit
Budget (period, category, limit)
FxRate (base, quote, date, rate)
AggregatorConnection (provider, external_id, status)  ──< Account
```

Core tables (abridged):
- **account**: id, user_id, name, type, currency, opening_amount_minor, opening_date, archived_at
- **transaction**: id, account_id, date, amount_minor, currency, payee, category_id (nullable if split), status, notes, transfer_group_id, external_fingerprint (nullable), created_at
- **transaction_split**: id, transaction_id, category_id, amount_minor (signed lines sum to the transaction total)
- **category**: id, user_id (null = system), parent_id, name, kind (income|expense)
- **budget**: id, user_id, category_id, period (YYYY-MM), limit_amount_minor, currency, rollover
- **fx_rate**: base, quote, date, rate (stored at high precision)
- **aggregator_connection**: id, user_id, provider, external_id, status, created_at

**Invariant:** `account balance = opening_amount + Σ(transactions)`. Enforced in the domain, verified by tests; the DB never stores a derived balance.

---

## 6. API surface (Phase 0, REST)

Versioned under `/v1`. JSON. Auth via bearer token. All money fields serialized as `{ amountMinor: string, currency: "USD" }` (string to survive JSON's 53-bit number limit for large `bigint`).

```
POST   /v1/accounts                 create account
GET    /v1/accounts                 list (with derived balances)
GET    /v1/accounts/:id             detail
PATCH  /v1/accounts/:id             edit / archive

GET    /v1/accounts/:id/transactions   register (paged, filterable)
POST   /v1/transactions             create (supports splits & transfers)
PATCH  /v1/transactions/:id         edit
DELETE /v1/transactions/:id         delete
POST   /v1/transactions/import      CSV / OFX import

GET    /v1/categories               list           POST /v1/categories
GET    /v1/budgets?period=YYYY-MM   budget vs actual
POST   /v1/budgets

GET    /v1/reports/net-worth?base=USD
GET    /v1/reports/cash-flow?from=&to=&base=
GET    /v1/reports/spending?groupBy=category|payee

GET    /v1/export                   full JSON export (data ownership)
```

Phase 1 adds `/v1/connections/*` (aggregation: connect, callback, sync, revoke).

---

## 7. Technology choices

| Concern | Choice | Why |
|---|---|---|
| Language | **TypeScript** everywhere | One language for core/server/web; strong types for money & domain |
| Money core | **Hand-rolled, zero-dep** (`bigint`) | No trust in third-party float libs; full test control |
| Server | **Fastify** | Fast, schema-first, small; good TS support |
| ORM / DB | **Prisma + PostgreSQL** | Migrations, type-safe queries; Postgres for integrity & BIGINT money |
| Web client | **React + Vite** | Ubiquitous, fast dev loop; core logic shared as a package |
| Mobile | **React Native** (later) | Reuses the TS core and much UI logic |
| Auth | Token-based (provider TBD) | Deferred detail; interface stubbed now |
| Tests | **Vitest** + property-based tests for money-core | Correctness is the crown jewel |
| Packaging | **pnpm workspaces** | First-class monorepo, strict dependency boundaries |

**Deliberately deferred:** the specific auth provider, hosting/infra, and the AI/ML stack (Phase 2). The architecture keeps them at the edges so they can be chosen late without disturbing the core.

---

## 8. Environments & runtime notes

- Local dev normally runs on Node 20+ with a Postgres container. **On this machine Node is not installed and Docker Desktop is paused**, so the code is authored and unit-tested against the framework-free `money-core` (runnable with `node --test` once a runtime is available). See the repo `README.md` for the exact bring-up commands.
- The `money-core` and `domain` packages have **no runtime dependency on a database or network**, so they can be tested in complete isolation — which is exactly why the highest-risk logic lives there.

---

## 9. Security & compliance architecture

- **Isolation:** every query is scoped by `user_id`; no cross-tenant reads.
- **At rest:** database encryption; secrets via environment/secret manager, never in the repo (`.env` is git-ignored, `.env.example` documents keys).
- **In transit:** TLS everywhere; aggregator callbacks verified by signature.
- **Consent:** open-banking access under the appropriate AISP arrangement; consent status is a first-class field with revocation wired to sever the connection and stop syncs.
- **Data ownership:** `/v1/export` and account deletion are product features, satisfying "no shutdown can brick your history."
- **Boundary:** no money movement in v1 → outside payment-institution licensing; this is a conscious scope line (see [PRD §2 non-goals](./PRD.md)).

---

## 10. Roadmap (build order)

| Phase | Theme | Ships |
|---|---|---|
| **0** | Foundation ledger | money-core, domain, API with in-memory + Prisma repos, accounts/transactions/budgets/reports, import, export |
| **1** | Connectivity | Salt Edge adapter, aggregation router, consent flow, auto-import + dedupe, rule categorization |
| **2** | Intelligence | ML categorization, subscription/anomaly detection, forecasting, NL query |
| **3** | Planning suite | Lifetime Planner, Debt Reduction, Events Modeler, goals, tax estimator |
| **4** | Wealth | Investments, crypto, real assets, allocation, net-worth history |
| **5** | Ecosystem | Shared households, roles, open read API, advisor mode |

**Current status:** Phase 0 in progress — `money-core` implemented with tests; domain types and API skeleton scaffolded.
