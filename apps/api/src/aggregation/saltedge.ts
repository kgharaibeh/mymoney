/**
 * SaltEdgeAggregationProvider — the real, global bank-data adapter.
 *
 * Salt Edge has the widest single footprint of any aggregator (thousands of
 * banks across 50+ countries), which is why it is our broad default; hence
 * `supportedCountries()` returns ["*"] so the router uses it as the fallback
 * for any country a more specific provider does not cover.
 *
 * NOTE: this makes live HTTP calls and needs SALT_EDGE_APP_ID / SALT_EDGE_SECRET.
 * It is intentionally NOT exercised by the test suite (which uses the sandbox
 * provider). Field names follow Salt Edge's v6 API shape and should be
 * re-verified against their current docs before going to production.
 */

import { Money } from "@mymoney/money-core";
import type {
  AggregationProvider,
  AggregatorConnection,
  NormalizedAccount,
  NormalizedTransaction,
} from "@mymoney/domain";

const BASE_URL = "https://www.saltedge.com/api/v6";

interface SaltEdgeConfig {
  appId: string;
  secret: string;
  /** Where Salt Edge sends the user back after the consent flow. */
  returnUrl: string;
}

export class SaltEdgeAggregationProvider implements AggregationProvider {
  readonly name = "salt_edge" as const;

  constructor(private readonly config: SaltEdgeConfig) {}

  /** Read config from the environment; returns null if not configured. */
  static fromEnv(): SaltEdgeAggregationProvider | null {
    const appId = process.env.SALT_EDGE_APP_ID;
    const secret = process.env.SALT_EDGE_SECRET;
    if (!appId || !secret) return null;
    return new SaltEdgeAggregationProvider({
      appId,
      secret,
      returnUrl: process.env.SALT_EDGE_RETURN_URL ?? "https://app.mymoney.local/connections/callback",
    });
  }

  supportedCountries(): string[] {
    return ["*"]; // broad global fallback
  }

  async startConnection(
    userId: string,
    _country: string,
  ): Promise<{ connectionId: string; redirectUrl: string }> {
    // Salt Edge identifies the end user by a "customer"; create/return one, then
    // open a hosted connect session and hand the URL back to the client.
    const customer = await this.request<{ data: { id: string } }>("POST", "/customers", {
      data: { identifier: userId },
    }).catch(() => null);
    const customerId = customer?.data.id;

    const session = await this.request<{ data: { connect_url: string; expires_at: string } }>(
      "POST",
      "/connections/connect",
      { data: { customer_id: customerId, consent: { scopes: ["account_details", "transactions_details"] }, return_to: this.config.returnUrl } },
    );
    // The permanent connection id arrives via callback/webhook; use the customer
    // as the correlation id until then.
    return { connectionId: customerId ?? "", redirectUrl: session.data.connect_url };
  }

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
      balance: Money.fromDecimal(String(a.balance), a.currency_code),
    }));
  }

  async fetchTransactions(
    connection: AggregatorConnection,
    externalAccountId: string,
    since: string,
  ): Promise<NormalizedTransaction[]> {
    const path =
      `/transactions?connection_id=${encodeURIComponent(connection.externalId)}` +
      `&account_id=${encodeURIComponent(externalAccountId)}&from_date=${encodeURIComponent(since)}`;
    const res = await this.request<{ data: SaltEdgeTransaction[] }>("GET", path);
    return res.data.map((t) => ({
      externalId: t.id,
      date: t.made_on,
      amount: Money.fromDecimal(String(t.amount), t.currency_code),
      payee: t.description,
      fingerprint: `saltedge:${t.id}`,
    }));
  }

  async revoke(connection: AggregatorConnection): Promise<void> {
    await this.request("DELETE", `/connections/${encodeURIComponent(connection.externalId)}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "App-id": this.config.appId,
        Secret: this.config.secret,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      throw new Error(`Salt Edge ${method} ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }
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
