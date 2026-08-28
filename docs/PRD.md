# MyMoney — Product Requirements Document

**Status:** Draft v0.2 · **Owner:** kgharaibeh@gmail.com · **Last updated:** 2026-08-28

Companion documents: [ARCHITECTURE.md](./ARCHITECTURE.md) · Landscape research: see the published build-plan artifact.

---

## 1. Summary

MyMoney is a cross-platform (web + mobile) personal-finance application that recovers the depth of Microsoft Money's planning tools, connects to bank accounts in **50+ countries** via a multi-aggregator layer (not just North America), and adds the intelligence and multi-currency support the desktop era never had.

**One-line positioning:** *The planning depth of Microsoft Money, the reach of global open banking, and an AI that actually understands your money — with data you own.*

### The gap we fill
No product today pairs **truly global bank connectivity** with **Money-grade planning depth**. Apps with global reach (MoneyWiz) have shallow planning; apps with deep planning (Monarch) are locked to North America. MyMoney targets that empty quadrant.

---

## 2. Goals & non-goals

### Goals (what success looks like)
1. A user in **any country** can track their finances — with a bank connection where open banking exists, and with fast manual/CSV entry everywhere else.
2. Every balance, budget, and net-worth figure is **multi-currency and FX-aware**.
3. The **planning suite** (retirement/lifetime projection, debt payoff, goals, tax estimation) is a live, first-class part of the product — the primary differentiator.
4. Users **own and can export** all their data at any time; no shutdown can ever brick their history.
5. Money math is **provably correct** — no floating-point drift, no lost pennies on splits.

### Non-goals (explicitly out of scope for v1)
- We are **not** a bank, wallet, or money-movement service. MyMoney never holds, moves, or transfers funds.
- We do **not** provide personalized/regulated investment advice.
- We do **not** execute trades or payments. (Open-banking *payment initiation* is a possible far-future add-on, deliberately deferred.)
- No tax *filing* in v1 — only estimation and export.
- No lending, credit products, or "buy now pay later" features.

---

## 3. Target users & personas

| Persona | Situation | Primary need |
|---|---|---|
| **The cross-border professional** | Salary in one currency, rent/savings in another; accounts in 2+ countries | Multi-currency net worth in one place; global bank sync |
| **The planner** | Wants to model retirement, pay down debt, hit savings goals | The revived Money planners, driven by real data |
| **The under-banked / cash user** | Region with limited open-banking coverage | Fast manual entry, CSV import, receipt capture — useful with zero bank links |
| **The household** | Shared finances with a partner | Shared budgets, roles, collaborative categorization |
| **The Money refugee** | Used MS Money/Quicken/Mint for years; distrusts cloud lock-in | Deep features + guaranteed data ownership & export |

Primary launch persona: **the cross-border professional** — the user least served by today's North-America-locked apps, and the clearest embodiment of our differentiator.

---

## 4. Product principles

1. **Global by default.** Country/provider is a routing decision, never a rewrite. No feature assumes USD or a US bank.
2. **Works before it connects.** The full ledger, budgeting, and planning experience is usable on day one with no bank link. Connectivity deepens; it does not gate.
3. **Correctness is a feature.** Integer minor-unit money, deterministic rounding, documented allocation. The ledger must always balance.
4. **The user owns the data.** One-click export, an open read API, offline access, and a clear consent/deletion surface.
5. **Intelligence assists, never decides.** AI categorizes, forecasts, and answers questions; the user stays in control and every automated action is reversible and explained.

---

## 5. Scope by release

Phases map to [ARCHITECTURE.md §Roadmap](./ARCHITECTURE.md). Each phase ships something usable on its own.

### Phase 0 — Foundation ledger (offline-capable MVP)
The part Money got right, rebuilt for the cloud, usable in every country with zero integrations.

- **Accounts:** create/edit/archive accounts of type `checking`, `savings`, `credit_card`, `cash`, `loan`, `investment`, `asset`. Each has a currency.
- **Transactions:** register with amount, date, payee, category, notes, tags, cleared/reconciled state. **Splits** (one transaction across multiple categories). **Transfers** between accounts (including cross-currency, with an explicit FX rate).
- **Categories:** hierarchical (group → category), income vs. expense, system defaults + user categories.
- **Budgets:** per-category monthly limits; rollover option; budget-vs-actual view.
- **Reconciliation:** mark cleared, reconcile to a statement balance.
- **Import:** CSV (mappable columns) and OFX/QFX.
- **Multi-currency:** every account and transaction carries a currency; net worth converts via a stored FX-rate table.
- **Reports:** net worth over time, cash flow, income vs. expense, spending by category/payee.
- **Security:** authenticated accounts, encryption at rest, per-user data isolation, full data export (JSON + CSV).

### Phase 1 — Global connectivity
- Salt Edge integration as the broad base (widest single footprint).
- **Aggregation adapter**: one internal interface; provider chosen per country/institution.
- Open-banking consent flow (PSD2-style), connection health, re-consent, revocation.
- Automatic transaction import with dedupe and transfer-pair detection.
- Rule-based auto-categorization (user-editable rules).

### Phase 2 — Intelligence
- ML categorization that learns per user (overrides rules over time).
- Subscription/recurring detection; anomaly and large-transaction alerts.
- Cash-flow forecasting (safe-to-spend, projected month-end balances).
- Natural-language queries over the user's own data ("how much did I spend on travel in Q2?").

### Phase 3 — Planning suite (the differentiator)
- **Lifetime Planner:** retirement & net-worth projection with income, contributions, inflation, returns.
- **Debt Reduction Planner:** avalanche & snowball strategies, payoff timelines, interest saved.
- **Events Modeler:** what-if scenarios (job change, house purchase, child, relocation).
- **Goals:** funded savings goals with progress and target dates.
- **Tax estimator:** income/deduction/capital-gains estimation; export for filing.

### Phase 4 — Wealth
- Investment/brokerage sync, crypto wallets, manual/real assets (property).
- Holdings, cost basis, allocation, and net-worth history including investments.

### Phase 5 — Ecosystem
- Shared households, roles & permissions, collaborative budgeting.
- Open read API, webhooks, advisor/accountant mode.

---

## 6. Detailed functional requirements (Phase 0)

IDs are stable references for tickets and tests.

### Accounts
- **FR-A1** A user can create an account with: name, type, currency (ISO 4217), opening balance, opening date.
- **FR-A2** Account balance is **always** the opening balance plus the sum of its posted transactions — never stored as a mutable field that can drift.
- **FR-A3** Accounts can be archived (hidden from active lists) but never hard-deleted while transactions reference them; export first.
- **FR-A4** Credit-card and loan accounts model liabilities: a positive balance owed reduces net worth.

### Transactions
- **FR-T1** A transaction has: account, date, amount (minor units + currency = account currency), payee, category (or splits), optional notes/tags, and a status (`uncleared` → `cleared` → `reconciled`).
- **FR-T2** A **split** transaction distributes its total across ≥2 category lines whose signed sum equals the transaction total exactly (validated by money-core; no residual pennies).
- **FR-T3** A **transfer** creates a linked pair of entries in two accounts. If the accounts differ in currency, the user supplies an FX rate; both legs are internally consistent (money-core `convert`).
- **FR-T4** Editing a transaction re-derives affected balances; the register never shows a stale balance.
- **FR-T5** Transactions can be bulk-selected to recategorize, tag, or delete.

### Categories & budgets
- **FR-C1** System ships default category groups (Income, Housing, Food, Transport, etc.); users add/rename/reparent/merge.
- **FR-B1** A budget assigns a monthly limit (money) to a category; the app computes actual, remaining, and % used for the period.
- **FR-B2** Optional rollover carries unspent/overspent amounts into the next period.

### Import
- **FR-I1** CSV import lets the user map columns (date, amount, payee, etc.), preview, and dedupe against existing transactions.
- **FR-I2** OFX/QFX import parses standard bank export files into transactions.

### Multi-currency
- **FR-M1** The system stores dated FX rates; net-worth and cross-account reports convert to a user-selected base currency using the rate effective on each date.
- **FR-M2** No arithmetic is ever performed between two different currencies without an explicit conversion (enforced by money-core).

### Reports
- **FR-R1** Net worth over time (assets − liabilities), converted to base currency.
- **FR-R2** Cash flow and income-vs-expense for a period.
- **FR-R3** Spending by category and by payee, filterable by account/date/tag.

### Data ownership & security
- **FR-S1** Full export of all user data as JSON and CSV, on demand, without support intervention.
- **FR-S2** Account deletion removes all personal data within a defined window and severs any aggregator consents.
- **FR-S3** All money-bearing fields use integer minor units; floats are prohibited in the ledger.

---

## 7. Cross-cutting / non-functional requirements

- **Correctness (NFR-1):** money-core has 100% branch coverage on arithmetic, allocation, rounding, and currency-guard paths. Property-based tests assert "splits never lose or invent minor units."
- **Privacy (NFR-2):** GDPR-aligned; data minimization; consent and deletion are product surfaces, not buried settings. No selling of user data — ever; this is a stated product value.
- **Security (NFR-3):** encryption at rest; TLS in transit; per-tenant isolation; secrets never in the repo; SOC 2-oriented controls from the start.
- **Availability (NFR-4):** the app is fully usable offline for viewing and manual entry; sync reconciles on reconnect.
- **Performance (NFR-5):** register and reports remain responsive at 100k+ transactions per user.
- **Portability (NFR-6):** no lock-in — documented data model, standard export formats, open read API by Phase 5.
- **Internationalization (NFR-7):** locale-aware dates, number formatting, and currency display from day one; UI copy externalized for translation.
- **Compliance boundary (NFR-8):** MyMoney is a **data aggregation and planning** tool. It is not a payment institution and initiates no money movement in v1, which keeps it outside the heaviest licensing regimes. Open-banking access is done under the appropriate AISP arrangement (directly or via the aggregator's licence).

---

## 8. Key product decisions & open questions

**Decided**
- Multi-aggregator from the start, abstracted behind one interface (Salt Edge first). Rationale: global reach is the whole thesis; a single-provider shortcut would be a rewrite later.
- Integer minor-unit money with an explicit currency on every amount. Rationale: correctness is a core value; floats are disqualifying for a ledger.
- Offline-capable ledger before connectivity. Rationale: usable in every country on day one; de-risks the aggregator dependency.

**Open (need a decision before/at the relevant phase)**
- **OQ-1 (Phase 0):** Client-side end-to-end encryption of transaction detail vs. server-side encryption only. E2E maximizes privacy but complicates server-side search, categorization, and AI. *Leaning:* server-side encryption + per-tenant isolation for v1; offer an E2E "vault" mode later. **Needs owner sign-off.**
- **OQ-2 (Phase 1):** Which second aggregator to add after Salt Edge — Tink (Europe depth) vs. Plaid (US depth) — depends on launch market.
- **OQ-3 (Phase 3):** How opinionated the Lifetime Planner's default assumptions should be (returns, inflation) given we do **not** give regulated advice; likely: user-set assumptions with clearly-labeled, editable defaults and disclaimers.
- **OQ-4 (business):** Monetization — subscription vs. freemium. Affects nothing in Phase 0 architecture but should be settled before Phase 2.

---

## 9. Success metrics (post-launch)

- **Activation:** % of new users who reach a populated net-worth view within their first session (via bank link *or* import *or* manual).
- **Global reach:** number of countries with ≥1 active connected account; share of active users outside North America.
- **Planning engagement:** % of active users who create at least one goal or run a planner.
- **Trust:** export usage without churn (proves ownership is real, not a churn signal); consent revocation friction.
- **Correctness:** zero ledger-imbalance incidents; zero penny-loss bug reports.
