/**
 * SandboxAggregationProvider — a deterministic fake "bank" that implements the
 * AggregationProvider port with no network or credentials. It lets the entire
 * connect -> sync -> categorize flow run in local dev and tests exactly as the
 * real providers do, so the sync engine is fully exercised offline.
 */

import { Money } from "@mymoney/money-core";
import type {
  AggregationProvider,
  AggregatorConnection,
  NormalizedAccount,
  NormalizedTransaction,
} from "@mymoney/domain";

interface SandboxTxn {
  externalId: string;
  date: string;
  amount: string; // decimal in the account currency
  payee: string;
}

const ACCOUNTS: Array<NormalizedAccount & { txns: SandboxTxn[] }> = [
  {
    externalId: "sb-checking",
    name: "Sandbox Checking",
    currency: "USD",
    type: "checking",
    balance: Money.fromDecimal("1937.66", "USD"),
    txns: [
      { externalId: "sb-chk-1", date: "2026-06-01", amount: "-12.34", payee: "STARBUCKS STORE 219" },
      { externalId: "sb-chk-2", date: "2026-06-02", amount: "-50.00", payee: "SHELL GAS 4471" },
      { externalId: "sb-chk-3", date: "2026-06-03", amount: "2000.00", payee: "ACME PAYROLL" },
    ],
  },
  {
    externalId: "sb-savings",
    name: "Sandbox Savings",
    currency: "USD",
    type: "savings",
    balance: Money.fromDecimal("5000.00", "USD"),
    txns: [{ externalId: "sb-sav-1", date: "2026-06-05", amount: "500.00", payee: "TRANSFER IN" }],
  },
];

export class SandboxAggregationProvider implements AggregationProvider {
  readonly name = "sandbox" as const;

  supportedCountries(): string[] {
    return ["SANDBOX"];
  }

  async startConnection(
    _userId: string,
    _country: string,
  ): Promise<{ connectionId: string; redirectUrl: string }> {
    const connectionId = `sandbox-${Math.random().toString(36).slice(2, 10)}`;
    return { connectionId, redirectUrl: `https://sandbox.mymoney.local/connect/${connectionId}` };
  }

  async listAccounts(_connection: AggregatorConnection): Promise<NormalizedAccount[]> {
    return ACCOUNTS.map((a) => ({
      externalId: a.externalId,
      name: a.name,
      currency: a.currency,
      type: a.type,
      balance: a.balance,
    }));
  }

  async fetchTransactions(
    _connection: AggregatorConnection,
    externalAccountId: string,
    since: string,
  ): Promise<NormalizedTransaction[]> {
    const account = ACCOUNTS.find((a) => a.externalId === externalAccountId);
    if (!account) return [];
    return account.txns
      .filter((t) => t.date >= since) // incremental: only on/after the cursor
      .map((t) => ({
        externalId: t.externalId,
        date: t.date,
        amount: Money.fromDecimal(t.amount, account.currency),
        payee: t.payee,
        fingerprint: `sandbox:${t.externalId}`,
      }));
  }

  async revoke(_connection: AggregatorConnection): Promise<void> {
    // Nothing to release for the fake provider.
  }
}
