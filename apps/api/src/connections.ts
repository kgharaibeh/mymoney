/**
 * ConnectionService — the Phase 1 bank-connectivity use-cases: start a bank
 * connection, sync it (discover accounts, pull new transactions, dedupe,
 * auto-categorize), revoke it, and manage categorization rules.
 *
 * The sync engine keeps the ledger invariant intact: when an account is first
 * linked, its opening balance is set to the provider's reported balance MINUS
 * the transactions imported in that first sync, so the derived balance
 * (opening + transactions) equals the bank's balance exactly.
 */

import { randomUUID } from "node:crypto";
import { sumMoney } from "@mymoney/money-core";
import {
  categorize,
  type Account,
  type AccountRepository,
  type AggregationProvider,
  type AggregatorConnection,
  type AggregatorConnectionRepository,
  type CategorizationRule,
  type CategorizationRuleRepository,
  type Clock,
  type HostedConnectProvider,
  type NormalizedTransaction,
  type ProviderCustomerRepository,
  type Transaction,
  type TransactionRepository,
} from "@mymoney/domain";
import type { AggregationRouter } from "./aggregation/router.js";
import { NotFoundError, ValidationError } from "./service.js";

type HostedProvider = AggregationProvider & HostedConnectProvider;
function isHostedConnect(p: AggregationProvider): p is HostedProvider {
  return typeof (p as Partial<HostedConnectProvider>).createConnectSession === "function";
}

const EPOCH = "1970-01-01";

export interface StartConnectionInput {
  country: string;
}

export interface SyncResult {
  accountsLinked: number;
  imported: number;
  skippedDuplicates: number;
}

export class ConnectionService {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly transactions: TransactionRepository,
    private readonly connections: AggregatorConnectionRepository,
    private readonly rules: CategorizationRuleRepository,
    private readonly router: AggregationRouter,
    private readonly clock: Clock,
    private readonly providerCustomers?: ProviderCustomerRepository,
    private readonly appBaseUrl: string = "http://localhost:5173",
  ) {}

  // ---- Hosted connect (real aggregators, e.g. Salt Edge) --------------------

  /** Start a hosted bank-connect session; returns the widget URL to redirect to. */
  async startHostedConnection(userId: string, input: { country: string }): Promise<{ redirectUrl: string }> {
    if (!input.country) throw new ValidationError(["`country` is required."]);
    const provider = this.router.forCountry(input.country);
    if (!isHostedConnect(provider)) {
      throw new ValidationError([`Provider "${provider.name}" does not support hosted bank connect.`]);
    }
    const customerId = await this.getOrCreateCustomer(userId, provider);
    const returnTo = `${this.appBaseUrl}/?linked=${provider.name}`;
    return provider.createConnectSession(customerId, returnTo);
  }

  /**
   * After the user returns from a hosted connect widget, import any new
   * connections from the provider(s) and sync their accounts + transactions.
   */
  async refreshConnections(
    userId: string,
  ): Promise<{ connectionsLinked: number; accountsLinked: number; imported: number; skippedDuplicates: number }> {
    let connectionsLinked = 0;
    let accountsLinked = 0;
    let imported = 0;
    let skippedDuplicates = 0;

    for (const provider of this.router.list()) {
      if (!isHostedConnect(provider) || !this.providerCustomers) continue;
      const pc = await this.providerCustomers.find(userId, provider.name);
      if (!pc) continue;

      const remote = await provider.listConnections(pc.externalId);
      const existing = await this.connections.listByUser(userId);
      for (const rc of remote) {
        let conn = existing.find((c) => c.provider === provider.name && c.externalId === rc.externalId);
        if (!conn) {
          conn = await this.connections.create({
            id: randomUUID(),
            userId,
            provider: provider.name,
            externalId: rc.externalId,
            status: rc.status,
            lastSyncedAt: null,
            createdAt: this.clock.now().toISOString(),
          });
          connectionsLinked++;
        }
        if (conn.status === "revoked") continue;
        const res = await this.syncConnection(userId, conn.id);
        accountsLinked += res.accountsLinked;
        imported += res.imported;
        skippedDuplicates += res.skippedDuplicates;
      }
    }
    return { connectionsLinked, accountsLinked, imported, skippedDuplicates };
  }

  private async getOrCreateCustomer(userId: string, provider: HostedProvider): Promise<string> {
    if (!this.providerCustomers) throw new Error("ProviderCustomer repository is not configured.");
    const existing = await this.providerCustomers.find(userId, provider.name);
    if (existing) return existing.externalId;
    const customerId = await provider.createCustomer(`mymoney-${userId}`);
    await this.providerCustomers.create({ id: randomUUID(), userId, provider: provider.name, externalId: customerId });
    return customerId;
  }

  // ---- Connect / list / revoke ---------------------------------------------

  async startConnection(
    userId: string,
    input: StartConnectionInput,
  ): Promise<{ connection: AggregatorConnection; redirectUrl: string }> {
    if (!input.country) throw new ValidationError(["`country` is required to choose a provider."]);
    const provider = this.router.forCountry(input.country);
    const { connectionId, redirectUrl } = await provider.startConnection(userId, input.country);

    const connection: AggregatorConnection = {
      id: randomUUID(),
      userId,
      provider: provider.name,
      externalId: connectionId,
      status: "active",
      lastSyncedAt: null,
      createdAt: this.clock.now().toISOString(),
    };
    await this.connections.create(connection);
    return { connection, redirectUrl };
  }

  async listConnections(userId: string): Promise<AggregatorConnection[]> {
    return this.connections.listByUser(userId);
  }

  async revokeConnection(userId: string, connectionId: string): Promise<AggregatorConnection> {
    const connection = await this.connections.findById(userId, connectionId);
    if (!connection) throw new NotFoundError("Connection");
    const provider = this.router.getByName(connection.provider);
    await provider.revoke(connection);
    return this.connections.update({ ...connection, status: "revoked" });
  }

  // ---- Sync -----------------------------------------------------------------

  async syncConnection(userId: string, connectionId: string): Promise<SyncResult> {
    const connection = await this.connections.findById(userId, connectionId);
    if (!connection) throw new NotFoundError("Connection");
    if (connection.status === "revoked") {
      throw new ValidationError(["This connection has been revoked; reconnect to sync."]);
    }

    const provider = this.router.getByName(connection.provider);
    const rules = await this.rules.listByUser(userId);
    const providerAccounts = await provider.listAccounts(connection);

    let accountsLinked = 0;
    let imported = 0;
    let skippedDuplicates = 0;

    for (const pa of providerAccounts) {
      const existing = await this.accounts.findByExternalId(userId, connection.id, pa.externalId);

      let account: Account;
      let since: string;
      if (existing) {
        account = existing;
        since = connection.lastSyncedAt ?? existing.openingDate;
      } else {
        // First link: pull full history so we can set a consistent opening balance.
        const firstTxns = await provider.fetchTransactions(connection, pa.externalId, EPOCH);
        const movement = sumMoney(
          firstTxns.map((t) => t.amount),
          pa.currency,
        );
        account = await this.accounts.create({
          id: randomUUID(),
          userId,
          name: pa.name,
          type: pa.type,
          currency: pa.currency,
          opening: pa.balance.minus(movement),
          openingDate: this.clock.today(),
          archivedAt: null,
          connectionId: connection.id,
          externalId: pa.externalId,
        });
        accountsLinked++;
        const res = await this.persist(userId, account, firstTxns, rules);
        imported += res.imported;
        skippedDuplicates += res.skipped;
        continue;
      }

      const txns = await provider.fetchTransactions(connection, pa.externalId, since);
      const res = await this.persist(userId, account, txns, rules);
      imported += res.imported;
      skippedDuplicates += res.skipped;
    }

    await this.connections.update({ ...connection, lastSyncedAt: this.clock.today() });
    return { accountsLinked, imported, skippedDuplicates };
  }

  /** Create the given normalized transactions, deduping and auto-categorizing. */
  private async persist(
    userId: string,
    account: Account,
    normalized: NormalizedTransaction[],
    rules: CategorizationRule[],
  ): Promise<{ imported: number; skipped: number }> {
    let imported = 0;
    let skipped = 0;
    for (const n of normalized) {
      if (await this.transactions.existsByFingerprint(account.id, n.fingerprint)) {
        skipped++;
        continue;
      }
      const txn: Transaction = {
        id: randomUUID(),
        accountId: account.id,
        date: n.date,
        amount: n.amount,
        payee: n.payee,
        categoryId: categorize(n.payee, rules),
        splits: [],
        status: "cleared", // came straight from the bank
        tags: [],
        transferGroupId: null,
        externalFingerprint: n.fingerprint,
        createdAt: this.clock.now().toISOString(),
      };
      (txn as Transaction & { userId: string }).userId = userId;
      await this.transactions.create(txn);
      imported++;
    }
    return { imported, skipped };
  }

  // ---- Rules ----------------------------------------------------------------

  async addRule(userId: string, input: { match: string; categoryId: string }): Promise<CategorizationRule> {
    if (!input.match?.trim()) throw new ValidationError(["Rule `match` is required."]);
    if (!input.categoryId?.trim()) throw new ValidationError(["Rule `categoryId` is required."]);
    return this.rules.create({
      id: randomUUID(),
      userId,
      match: input.match.trim(),
      categoryId: input.categoryId.trim(),
    });
  }

  async listRules(userId: string): Promise<CategorizationRule[]> {
    return this.rules.listByUser(userId);
  }
}
