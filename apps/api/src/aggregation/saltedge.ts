/**
 * SaltEdgeAggregationProvider — Salt Edge Account Information API v6.
 *
 * Salt Edge has the widest Gulf/MENA + global bank coverage, so it registers as
 * the "*" fallback in the router. It uses a hosted connect widget: we create a
 * customer for our user, open a connect session (a `connect_url` the user is
 * redirected to), the user authenticates with their bank + consents, and we then
 * import their connections, accounts, and transactions.
 *
 * Auth: App-id + Secret headers. Live mode additionally requires RSA request
 * signing — enabled automatically when SALT_EDGE_PRIVATE_KEY is configured (test
 * mode needs no signing).
 */

import { createSign } from "node:crypto";
import { Money } from "@mymoney/money-core";
import type {
  AggregationProvider,
  AggregatorConnection,
  ConnectionStatus,
  HostedConnectProvider,
  NormalizedAccount,
  NormalizedTransaction,
} from "@mymoney/domain";

const BASE_URL = "https://www.saltedge.com/api/v6";

interface SaltEdgeConfig {
  appId: string;
  secret: string;
  /** PEM private key for request signing (live mode); optional in test mode. */
  privateKey?: string;
  /** In test mode, surface Salt Edge's fake/test banks in the connect widget. */
  includeFakeProviders?: boolean;
}

export class SaltEdgeAggregationProvider implements AggregationProvider, HostedConnectProvider {
  readonly name = "salt_edge" as const;

  constructor(private readonly config: SaltEdgeConfig) {}

  static fromEnv(): SaltEdgeAggregationProvider | null {
    const appId = process.env.SALT_EDGE_APP_ID;
    const secret = process.env.SALT_EDGE_SECRET;
    if (!appId || !secret) return null;
    return new SaltEdgeAggregationProvider({
      appId,
      secret,
      privateKey: process.env.SALT_EDGE_PRIVATE_KEY,
      includeFakeProviders: process.env.SALT_EDGE_INCLUDE_FAKE_PROVIDERS === "true",
    });
  }

  supportedCountries(): string[] {
    return ["*"]; // broad global/Gulf fallback
  }

  // ---- Hosted connect flow --------------------------------------------------

  async createCustomer(identifier: string): Promise<string> {
    const res = await this.request<{ data: { customer_id: string } }>("POST", "/customers", {
      data: { identifier },
    });
    return res.data.customer_id;
  }

  async createConnectSession(customerId: string, returnTo: string): Promise<{ redirectUrl: string }> {
    const data: Record<string, unknown> = {
      customer_id: customerId,
      consent: { scopes: ["accounts", "transactions"] },
      attempt: { return_to: returnTo },
    };
    if (this.config.includeFakeProviders) data.include_fake_providers = true;
    const res = await this.request<{ data: { connect_url: string } }>("POST", "/connections/connect", { data });
    return { redirectUrl: res.data.connect_url };
  }

  async listConnections(customerId: string): Promise<Array<{ externalId: string; status: ConnectionStatus }>> {
    const res = await this.request<{ data: SaltEdgeConnection[] }>(
      "GET",
      `/connections?customer_id=${encodeURIComponent(customerId)}`,
    );
    return res.data.map((c) => ({ externalId: c.id, status: mapStatus(c.status) }));
  }

  // ---- Per-connection sync (AggregationProvider) ----------------------------

  async listAccounts(connection: AggregatorConnection): Promise<NormalizedAccount[]> {
    const res = await this.request<{ data: SaltEdgeAccount[] }>(
      "GET",
      `/accounts?connection_id=${encodeURIComponent(connection.externalId)}`,
    );
    return res.data.map((a) => ({
      externalId: a.id,
      name: a.name,
      currency: a.currency_code,
      type: mapAccountNature(a.nature),
      balance: Money.fromDecimal(String(a.balance ?? 0), a.currency_code),
    }));
  }

  async fetchTransactions(
    connection: AggregatorConnection,
    externalAccountId: string,
    since: string,
  ): Promise<NormalizedTransaction[]> {
    const out: NormalizedTransaction[] = [];
    let fromId: string | null = null;
    // Paginate via meta.next_id until exhausted.
    for (let guard = 0; guard < 100; guard++) {
      const params = new URLSearchParams({
        connection_id: connection.externalId,
        account_id: externalAccountId,
        from_date: since,
      });
      if (fromId) params.set("from_id", fromId);
      const res: { data: SaltEdgeTransaction[]; meta?: { next_id: string | null } } = await this.request(
        "GET",
        `/transactions?${params.toString()}`,
      );
      for (const t of res.data) {
        out.push({
          externalId: t.id,
          date: t.made_on,
          amount: Money.fromDecimal(String(t.amount), t.currency_code),
          payee: t.description,
          fingerprint: `saltedge:${t.id}`,
        });
      }
      fromId = res.meta?.next_id ?? null;
      if (!fromId) break;
    }
    return out;
  }

  async revoke(connection: AggregatorConnection): Promise<void> {
    await this.request("DELETE", `/connections/${encodeURIComponent(connection.externalId)}`);
  }

  /** Not used: Salt Edge uses the hosted connect flow (createConnectSession). */
  async startConnection(): Promise<{ connectionId: string; redirectUrl: string }> {
    throw new Error("Salt Edge uses the hosted connect flow; call createConnectSession.");
  }

  // ---- HTTP with optional RSA signing --------------------------------------

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${BASE_URL}${path}`;
    const payload = body ? JSON.stringify(body) : "";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "App-id": this.config.appId,
      Secret: this.config.secret,
    };
    if (this.config.privateKey) {
      const expiresAt = Math.floor(Date.now() / 1000) + 60;
      const signature = createSign("RSA-SHA256")
        .update(`${expiresAt}|${method}|${url}|${payload}`)
        .sign(this.config.privateKey, "base64");
      headers["Expires-at"] = String(expiresAt);
      headers["Signature"] = signature;
    }
    const res = await fetch(url, { method, headers, ...(payload ? { body: payload } : {}) });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Salt Edge ${method} ${path} failed: ${res.status} ${text}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}

interface SaltEdgeConnection {
  id: string;
  status: string;
}
interface SaltEdgeAccount {
  id: string;
  name: string;
  currency_code: string;
  balance: number;
  nature: string;
}
interface SaltEdgeTransaction {
  id: string;
  made_on: string;
  amount: number;
  currency_code: string;
  description: string;
}

function mapStatus(status: string): ConnectionStatus {
  switch (status) {
    case "active":
      return "active";
    case "inactive":
    case "disabled":
      return "needs_reconsent";
    default:
      return "error";
  }
}

function mapAccountNature(nature: string): NormalizedAccount["type"] {
  switch (nature) {
    case "card":
    case "credit_card":
      return "credit_card";
    case "savings":
      return "savings";
    case "loan":
    case "mortgage":
      return "loan";
    case "investment":
      return "investment";
    default:
      return "checking";
  }
}
