/**
 * Ports — interfaces the domain owns and adapters implement (hexagonal
 * architecture). The domain depends on these; it never imports a database
 * client or an aggregator SDK directly. That is what lets us swap Postgres for
 * an in-memory store in tests, and route between bank aggregators per country.
 */

import type { Money } from "@mymoney/money-core";
import type {
  Account,
  AggregatorConnection,
  AggregatorProviderName,
  Budget,
  CategorizationRule,
  Category,
  ConnectionStatus,
  ProviderCustomer,
  Transaction,
  UserAccount,
} from "./types.js";

export interface UserRepository {
  create(user: UserAccount): Promise<UserAccount>;
  findByEmail(email: string): Promise<UserAccount | null>;
  findById(id: string): Promise<UserAccount | null>;
  update(user: UserAccount): Promise<UserAccount>;
}

export interface AccountRepository {
  create(account: Account): Promise<Account>;
  findById(userId: string, id: string): Promise<Account | null>;
  listByUser(userId: string, opts?: { includeArchived?: boolean }): Promise<Account[]>;
  update(account: Account): Promise<Account>;
  /** Find a linked account by its aggregator connection + provider account id. */
  findByExternalId(userId: string, connectionId: string, externalId: string): Promise<Account | null>;
}

export interface TransactionRepository {
  create(txn: Transaction): Promise<Transaction>;
  findById(userId: string, id: string): Promise<Transaction | null>;
  listByAccount(
    accountId: string,
    opts?: { from?: string; to?: string; limit?: number; offset?: number },
  ): Promise<Transaction[]>;
  listByUser(userId: string): Promise<Transaction[]>;
  update(txn: Transaction): Promise<Transaction>;
  delete(userId: string, id: string): Promise<void>;
  /** For import dedupe: does a transaction with this fingerprint already exist? */
  existsByFingerprint(accountId: string, fingerprint: string): Promise<boolean>;
}

export interface CategoryRepository {
  create(category: Category): Promise<Category>;
  listForUser(userId: string): Promise<Category[]>; // includes system categories
}

export interface BudgetRepository {
  upsert(budget: Budget): Promise<Budget>;
  listByPeriod(userId: string, period: string): Promise<Budget[]>;
  listByUser(userId: string): Promise<Budget[]>;
}

export interface AggregatorConnectionRepository {
  create(connection: AggregatorConnection): Promise<AggregatorConnection>;
  findById(userId: string, id: string): Promise<AggregatorConnection | null>;
  listByUser(userId: string): Promise<AggregatorConnection[]>;
  update(connection: AggregatorConnection): Promise<AggregatorConnection>;
}

export interface CategorizationRuleRepository {
  create(rule: CategorizationRule): Promise<CategorizationRule>;
  listByUser(userId: string): Promise<CategorizationRule[]>;
}

export interface ProviderCustomerRepository {
  create(pc: ProviderCustomer): Promise<ProviderCustomer>;
  find(userId: string, provider: AggregatorProviderName): Promise<ProviderCustomer | null>;
}

/**
 * A provider that uses a hosted "connect widget" flow (like Salt Edge): the user
 * is redirected to the provider to pick and authenticate with their bank, then
 * returns to the app. Implemented alongside AggregationProvider (which supplies
 * the per-connection account/transaction sync).
 */
export interface HostedConnectProvider {
  /** Create (or return) the provider's customer for our user identifier. */
  createCustomer(identifier: string): Promise<string>;
  /** Start a connect session; returns the hosted widget URL to redirect to. */
  createConnectSession(customerId: string, returnTo: string): Promise<{ redirectUrl: string }>;
  /** List the provider's connections for a customer (to import after linking). */
  listConnections(customerId: string): Promise<Array<{ externalId: string; status: ConnectionStatus }>>;
}

/** Dated FX rates. Returns base units per one `from` unit for a given date. */
export interface FxRateProvider {
  /** Rate string for `from`->`to` effective on `date` (nearest on/before). */
  getRate(from: string, to: string, date: string): Promise<string>;
}

/** Injectable clock so time-dependent logic is deterministic under test. */
export interface Clock {
  now(): Date;
  today(): string; // ISO date (YYYY-MM-DD)
}

// ---- Aggregation port -------------------------------------------------------

export interface NormalizedAccount {
  externalId: string;
  name: string;
  currency: string;
  balance: Money;
  type: Account["type"];
}

export interface NormalizedTransaction {
  externalId: string;
  date: string;
  amount: Money;
  payee: string;
  /** Stable fingerprint used for dedupe across re-syncs. */
  fingerprint: string;
}

/**
 * The single interface every bank aggregator adapter (Salt Edge, Tink, Plaid,
 * TrueLayer) implements. The AggregationRouter picks one per country/institution
 * and normalizes everything into the shapes above before it reaches the domain.
 */
export interface AggregationProvider {
  readonly name: AggregatorProviderName;
  /** Countries (ISO 3166-1 alpha-2) this provider can serve. */
  supportedCountries(): string[];
  /** Begin a consent/link flow; returns a URL or token for the client. */
  startConnection(userId: string, country: string): Promise<{ connectionId: string; redirectUrl: string }>;
  listAccounts(connection: AggregatorConnection): Promise<NormalizedAccount[]>;
  fetchTransactions(
    connection: AggregatorConnection,
    externalAccountId: string,
    since: string,
  ): Promise<NormalizedTransaction[]>;
  revoke(connection: AggregatorConnection): Promise<void>;
}
