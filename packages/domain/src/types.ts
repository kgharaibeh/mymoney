/**
 * Core domain entities and value objects.
 *
 * These are pure data + the `Money` value type. They know nothing about HTTP,
 * databases, or aggregation providers — those live in adapters (apps/api).
 */

import type { Money } from "@mymoney/money-core";

/** An authenticated user. `passwordHash` is an opaque KDF string, never plaintext. */
export interface UserAccount {
  id: string;
  email: string;
  passwordHash: string;
  /** Bumped to revoke all outstanding tokens (logout-everywhere, password change). */
  tokenVersion: number;
  createdAt: string;
}

export type AccountType =
  | "checking"
  | "savings"
  | "credit_card"
  | "cash"
  | "loan"
  | "investment"
  | "asset";

/** Liability accounts reduce net worth when their balance is positive (owed). */
export const LIABILITY_TYPES: ReadonlySet<AccountType> = new Set(["credit_card", "loan"]);

export interface Account {
  id: string;
  userId: string;
  name: string;
  type: AccountType;
  currency: string;
  /** Balance the account had before the first tracked transaction. */
  opening: Money;
  openingDate: string; // ISO date (YYYY-MM-DD)
  archivedAt: string | null;
  /** Set when the account is linked to a bank via an aggregator connection. */
  connectionId?: string | null;
  /** The provider's id for this account, used to match it on re-sync. */
  externalId?: string | null;
}

export type CategoryKind = "income" | "expense";

export interface Category {
  id: string;
  /** null userId = a system default category shared by everyone. */
  userId: string | null;
  parentId: string | null;
  name: string;
  kind: CategoryKind;
}

export type TransactionStatus = "uncleared" | "cleared" | "reconciled";

/** One line of a split transaction; signed lines sum to the transaction total. */
export interface TransactionSplit {
  categoryId: string;
  amount: Money;
  note?: string;
}

export interface Transaction {
  id: string;
  accountId: string;
  date: string; // ISO date
  amount: Money; // signed: negative = money out, positive = money in
  payee: string;
  /** Set when the transaction is a single category; null when it is split. */
  categoryId: string | null;
  splits: TransactionSplit[]; // empty unless this is a split transaction
  status: TransactionStatus;
  notes?: string;
  tags: string[];
  /** Links the two legs of a transfer (same value on both). */
  transferGroupId: string | null;
  /** Stable fingerprint from an aggregator import, for dedupe. */
  externalFingerprint: string | null;
  createdAt: string; // ISO datetime
}

export interface Budget {
  id: string;
  userId: string;
  categoryId: string;
  period: string; // "YYYY-MM"
  limit: Money;
  rollover: boolean;
}

export type AggregatorProviderName = "salt_edge" | "tink" | "plaid" | "truelayer" | "sandbox";
export type ConnectionStatus = "active" | "needs_reconsent" | "revoked" | "error";

export interface AggregatorConnection {
  id: string;
  userId: string;
  provider: AggregatorProviderName;
  externalId: string;
  status: ConnectionStatus;
  createdAt: string;
  /** Cursor for incremental sync: the last time transactions were pulled. */
  lastSyncedAt?: string | null;
}

/**
 * A user-defined rule that auto-assigns a category to imported transactions
 * whose payee contains `match` (case-insensitive). First matching rule wins.
 */
export interface CategorizationRule {
  id: string;
  userId: string;
  match: string;
  categoryId: string;
}
