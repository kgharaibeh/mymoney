// Typed client for the MyMoney API. Auth is the placeholder x-user-id header;
// the user id is stored in localStorage so you can simulate different users.

const TOKEN_KEY = "mymoney.token";
const EMAIL_KEY = "mymoney.email";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function getEmail(): string | null {
  return localStorage.getItem(EMAIL_KEY);
}
export function setSession(token: string, email: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(EMAIL_KEY, email);
}
export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EMAIL_KEY);
}

export interface AuthResultDTO {
  token: string;
  user: { id: string; email: string };
}

export interface MoneyDTO {
  amountMinor: string;
  currency: string;
  decimal: string;
}
export interface AccountDTO {
  id: string;
  name: string;
  type: string;
  currency: string;
  opening: MoneyDTO;
  openingDate: string;
  archived: boolean;
  balance?: MoneyDTO;
}
export interface TransactionDTO {
  id: string;
  accountId: string;
  date: string;
  amount: MoneyDTO;
  payee: string;
  categoryId: string | null;
  splits: Array<{ categoryId: string; amount: MoneyDTO; note?: string }>;
  status: string;
  tags: string[];
  notes: string | null;
}
export interface NetWorthDTO {
  base: string;
  netWorth: MoneyDTO;
}
export interface ImportResultDTO {
  imported: number;
  skippedDuplicates: number;
  errors: string[];
}
export interface BudgetLineDTO {
  id: string;
  categoryId: string;
  period: string;
  limit: MoneyDTO;
  rollover: boolean;
  spent: MoneyDTO;
  remaining: MoneyDTO;
}
export interface ConnectionDTO {
  id: string;
  provider: string;
  status: string;
  lastSyncedAt: string | null;
  createdAt: string;
  redirectUrl?: string;
}
export interface SyncResultDTO {
  accountsLinked: number;
  imported: number;
  skippedDuplicates: number;
}
export interface RuleDTO {
  id: string;
  match: string;
  categoryId: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers["authorization"] = `Bearer ${token}`;
  // Only advertise a JSON body when there actually is one — otherwise Fastify's
  // JSON parser rejects the empty body on bodyless POSTs (sync, revoke, archive).
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    // A 401 on an authenticated call means the session is gone — clear it so the
    // app falls back to the login screen.
    if (res.status === 401 && token) clearSession();
    const message =
      (data && (data.problems?.join(" ") || data.message)) || `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export const api = {
  // Auth
  signup: (email: string, password: string) =>
    request<AuthResultDTO>("POST", "/v1/auth/signup", { email, password }),
  login: (email: string, password: string) =>
    request<AuthResultDTO>("POST", "/v1/auth/login", { email, password }),
  me: () => request<{ id: string; email: string }>("GET", "/v1/auth/me"),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<AuthResultDTO>("POST", "/v1/auth/change-password", { currentPassword, newPassword }),
  logoutEverywhere: () => request<AuthResultDTO>("POST", "/v1/auth/logout-all"),

  // Accounts
  listAccounts: () => request<AccountDTO[]>("GET", "/v1/accounts"),
  createAccount: (input: {
    name: string;
    type: string;
    currency: string;
    openingBalance?: string;
  }) => request<AccountDTO>("POST", "/v1/accounts", input),
  archiveAccount: (id: string) => request<AccountDTO>("POST", `/v1/accounts/${id}/archive`),

  // Transactions
  listTransactions: (accountId: string) =>
    request<TransactionDTO[]>("GET", `/v1/accounts/${accountId}/transactions`),
  createTransaction: (input: {
    accountId: string;
    date: string;
    amount: string;
    payee: string;
    categoryId?: string | null;
  }) => request<TransactionDTO>("POST", "/v1/transactions", input),
  deleteTransaction: (id: string) => request<void>("DELETE", `/v1/transactions/${id}`),
  importCsv: (input: {
    accountId: string;
    csv: string;
    hasHeader: boolean;
    mapping: Record<string, string | number>;
  }) => request<ImportResultDTO>("POST", "/v1/transactions/import", input),
  importOfx: (input: { accountId: string; ofx: string }) =>
    request<ImportResultDTO>("POST", "/v1/transactions/import-ofx", input),

  // Reports
  netWorth: (base: string) => request<NetWorthDTO>("GET", `/v1/reports/net-worth?base=${base}`),

  // Budgets
  listBudgets: (period: string) => request<BudgetLineDTO[]>("GET", `/v1/budgets?period=${period}`),
  createBudget: (input: {
    categoryId: string;
    period: string;
    limit: string;
    currency: string;
  }) => request<BudgetLineDTO>("POST", "/v1/budgets", input),

  // Connections + rules
  listConnections: () => request<ConnectionDTO[]>("GET", "/v1/connections"),
  startConnection: (country: string) =>
    request<ConnectionDTO>("POST", "/v1/connections", { country }),
  syncConnection: (id: string) =>
    request<SyncResultDTO>("POST", `/v1/connections/${id}/sync`),
  revokeConnection: (id: string) =>
    request<ConnectionDTO>("POST", `/v1/connections/${id}/revoke`),
  listRules: () => request<RuleDTO[]>("GET", "/v1/rules"),
  addRule: (input: { match: string; categoryId: string }) =>
    request<RuleDTO>("POST", "/v1/rules", input),
};
