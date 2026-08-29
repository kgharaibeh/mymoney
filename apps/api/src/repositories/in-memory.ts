/**
 * In-memory adapter implementations of the domain ports.
 *
 * These let the whole API run and be tested with zero external services — no
 * Postgres, no network. The Prisma-backed adapters (prisma/schema.prisma) will
 * implement the exact same interfaces for production, so nothing in the domain
 * or routes changes when we swap them in.
 */

import type {
  Account,
  AccountRepository,
  AggregatorConnection,
  AggregatorConnectionRepository,
  Budget,
  BudgetRepository,
  AggregatorProviderName,
  CategorizationRule,
  CategorizationRuleRepository,
  Category,
  CategoryRepository,
  Clock,
  FxRateProvider,
  ProviderCustomer,
  ProviderCustomerRepository,
  Transaction,
  TransactionRepository,
  UserAccount,
  UserRepository,
} from "@mymoney/domain";

export class InMemoryAccountRepository implements AccountRepository {
  private accounts = new Map<string, Account>();

  async create(account: Account): Promise<Account> {
    this.accounts.set(account.id, account);
    return account;
  }
  async findById(userId: string, id: string): Promise<Account | null> {
    const a = this.accounts.get(id);
    return a && a.userId === userId ? a : null;
  }
  async listByUser(userId: string, opts?: { includeArchived?: boolean }): Promise<Account[]> {
    return [...this.accounts.values()].filter(
      (a) => a.userId === userId && (opts?.includeArchived || !a.archivedAt),
    );
  }
  async update(account: Account): Promise<Account> {
    this.accounts.set(account.id, account);
    return account;
  }
  async findByExternalId(userId: string, connectionId: string, externalId: string): Promise<Account | null> {
    return (
      [...this.accounts.values()].find(
        (a) => a.userId === userId && a.connectionId === connectionId && a.externalId === externalId,
      ) ?? null
    );
  }
}

export class InMemoryTransactionRepository implements TransactionRepository {
  private txns = new Map<string, Transaction>();

  async create(txn: Transaction): Promise<Transaction> {
    this.txns.set(txn.id, txn);
    return txn;
  }
  async findById(_userId: string, id: string): Promise<Transaction | null> {
    // userId scoping in the in-memory store is validated at the service layer
    return this.txns.get(id) ?? null;
  }
  async listByAccount(
    accountId: string,
    opts?: { from?: string; to?: string; limit?: number; offset?: number },
  ): Promise<Transaction[]> {
    let list = [...this.txns.values()]
      .filter((t) => t.accountId === accountId)
      .filter((t) => (opts?.from ? t.date >= opts.from : true))
      .filter((t) => (opts?.to ? t.date <= opts.to : true))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const offset = opts?.offset ?? 0;
    if (opts?.limit != null) list = list.slice(offset, offset + opts.limit);
    return list;
  }
  async listByUser(userId: string): Promise<Transaction[]> {
    return [...this.txns.values()].filter((t) => t.userId === userId);
  }
  async update(txn: Transaction): Promise<Transaction> {
    this.txns.set(txn.id, txn);
    return txn;
  }
  async delete(_userId: string, id: string): Promise<void> {
    this.txns.delete(id);
  }
  async existsByFingerprint(accountId: string, fingerprint: string): Promise<boolean> {
    return [...this.txns.values()].some(
      (t) => t.accountId === accountId && t.externalFingerprint === fingerprint,
    );
  }
}

// The in-memory transaction store keys off a `userId` we attach for filtering.
declare module "@mymoney/domain" {
  interface Transaction {
    userId?: string;
  }
}

export class InMemoryCategoryRepository implements CategoryRepository {
  private categories = new Map<string, Category>();
  async create(category: Category): Promise<Category> {
    this.categories.set(category.id, category);
    return category;
  }
  async listForUser(userId: string): Promise<Category[]> {
    return [...this.categories.values()].filter((c) => c.userId === null || c.userId === userId);
  }
}

export class InMemoryBudgetRepository implements BudgetRepository {
  private budgets = new Map<string, Budget>();
  async upsert(budget: Budget): Promise<Budget> {
    this.budgets.set(budget.id, budget);
    return budget;
  }
  async listByPeriod(userId: string, period: string): Promise<Budget[]> {
    return [...this.budgets.values()].filter((b) => b.userId === userId && b.period === period);
  }
  async listByUser(userId: string): Promise<Budget[]> {
    return [...this.budgets.values()].filter((b) => b.userId === userId);
  }
}

/**
 * A trivial FX provider seeded with static rates against USD. Real deployments
 * replace this with a dated-rate feed; the interface is identical.
 */
export class StaticFxRateProvider implements FxRateProvider {
  // units of USD per 1 unit of the key currency
  private usdPer: Record<string, string> = {
    USD: "1",
    EUR: "1.08",
    GBP: "1.27",
    JPY: "0.0067",
    AED: "0.27",
    SAR: "0.27",
    JOD: "1.41",
  };
  async getRate(from: string, to: string, _date: string): Promise<string> {
    const f = this.usdPer[from.toUpperCase()];
    const t = this.usdPer[to.toUpperCase()];
    if (!f || !t) throw new Error(`No FX rate for ${from}->${to}`);
    // (USD per from) / (USD per to) = to per from
    return (Number(f) / Number(t)).toString();
  }
}

export class InMemoryAggregatorConnectionRepository implements AggregatorConnectionRepository {
  private connections = new Map<string, AggregatorConnection>();
  async create(connection: AggregatorConnection): Promise<AggregatorConnection> {
    this.connections.set(connection.id, connection);
    return connection;
  }
  async findById(userId: string, id: string): Promise<AggregatorConnection | null> {
    const c = this.connections.get(id);
    return c && c.userId === userId ? c : null;
  }
  async listByUser(userId: string): Promise<AggregatorConnection[]> {
    return [...this.connections.values()].filter((c) => c.userId === userId);
  }
  async update(connection: AggregatorConnection): Promise<AggregatorConnection> {
    this.connections.set(connection.id, connection);
    return connection;
  }
}

export class InMemoryCategorizationRuleRepository implements CategorizationRuleRepository {
  private rules: CategorizationRule[] = [];
  async create(rule: CategorizationRule): Promise<CategorizationRule> {
    this.rules.push(rule);
    return rule;
  }
  async listByUser(userId: string): Promise<CategorizationRule[]> {
    return this.rules.filter((r) => r.userId === userId);
  }
}

export class InMemoryProviderCustomerRepository implements ProviderCustomerRepository {
  private items: ProviderCustomer[] = [];
  async create(pc: ProviderCustomer): Promise<ProviderCustomer> {
    this.items.push(pc);
    return pc;
  }
  async find(userId: string, provider: AggregatorProviderName): Promise<ProviderCustomer | null> {
    return this.items.find((p) => p.userId === userId && p.provider === provider) ?? null;
  }
}

export class InMemoryUserRepository implements UserRepository {
  private byId = new Map<string, UserAccount>();
  private byEmail = new Map<string, UserAccount>();
  async create(user: UserAccount): Promise<UserAccount> {
    this.byId.set(user.id, user);
    this.byEmail.set(user.email, user);
    return user;
  }
  async findByEmail(email: string): Promise<UserAccount | null> {
    return this.byEmail.get(email) ?? null;
  }
  async findById(id: string): Promise<UserAccount | null> {
    return this.byId.get(id) ?? null;
  }
  async update(user: UserAccount): Promise<UserAccount> {
    this.byId.set(user.id, user);
    this.byEmail.set(user.email, user);
    return user;
  }
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  today(): string {
    return new Date().toISOString().slice(0, 10);
  }
}
