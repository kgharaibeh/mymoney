/**
 * Authentication: email/password signup + login, password hashing, and bearer
 * tokens — plus revocation and brute-force protection. Zero external deps:
 * scrypt for password hashing, HS256 JWTs signed with node:crypto.
 *
 * Passwords are never stored or logged in plaintext (only a salted scrypt
 * digest). Tokens carry a `ver` claim checked against the user's `tokenVersion`,
 * so bumping that version (password change, log-out-everywhere) revokes every
 * outstanding token immediately.
 */

import { createHmac, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { UserAccount, UserRepository } from "@mymoney/domain";

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const KEYLEN = 64;
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200; // guard against scrypt CPU-DoS on huge inputs
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export class AuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface AuthInput {
  email: string;
  password: string;
}
export interface AuthResult {
  token: string;
  user: { id: string; email: string };
}

/** In-memory sliding-window limiter keyed by (e.g.) email. Per-process. */
class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  allowed(key: string): boolean {
    return this.recent(key).length < this.max;
  }
  record(key: string): void {
    const arr = this.recent(key);
    arr.push(Date.now());
    this.hits.set(key, arr);
  }
  reset(key: string): void {
    this.hits.delete(key);
  }
  private recent(key: string): number[] {
    const now = Date.now();
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
  }
}

export class AuthService {
  private readonly loginLimiter = new RateLimiter(MAX_LOGIN_ATTEMPTS, LOGIN_WINDOW_MS);

  constructor(
    private readonly users: UserRepository,
    private readonly secret: string,
  ) {}

  async signup(input: AuthInput): Promise<AuthResult> {
    const email = normalizeEmail(input.email);
    if (!isValidEmail(email)) throw new AuthError(400, "Enter a valid email address.");
    assertPasswordShape(input.password);
    if (await this.users.findByEmail(email)) {
      throw new AuthError(409, "An account with that email already exists.");
    }
    const user: UserAccount = {
      id: randomUUID(),
      email,
      passwordHash: await hashPassword(input.password),
      tokenVersion: 0,
      createdAt: new Date().toISOString(),
    };
    await this.users.create(user);
    return this.result(user);
  }

  async login(input: AuthInput): Promise<AuthResult> {
    const email = normalizeEmail(input.email);
    if (!email || typeof input.password !== "string" || input.password.length === 0) {
      throw new AuthError(401, "Incorrect email or password.");
    }
    if (!this.loginLimiter.allowed(email)) {
      throw new AuthError(429, "Too many login attempts. Please wait a few minutes and try again.");
    }
    const user = await this.users.findByEmail(email);
    const ok = user
      ? await verifyPassword(input.password, user.passwordHash)
      : await verifyPassword(input.password, DUMMY_HASH).then(() => false);
    if (!user || !ok) {
      this.loginLimiter.record(email);
      throw new AuthError(401, "Incorrect email or password.");
    }
    this.loginLimiter.reset(email);
    return this.result(user);
  }

  async me(userId: string): Promise<{ id: string; email: string }> {
    const user = await this.users.findById(userId);
    if (!user) throw new AuthError(401, "Session no longer valid.");
    return { id: user.id, email: user.email };
  }

  /** Change the password, verifying the current one, and revoke old tokens. */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<AuthResult> {
    const user = await this.users.findById(userId);
    if (!user) throw new AuthError(401, "Session no longer valid.");
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new AuthError(401, "Current password is incorrect.");
    }
    assertPasswordShape(newPassword);
    const updated: UserAccount = {
      ...user,
      passwordHash: await hashPassword(newPassword),
      tokenVersion: user.tokenVersion + 1, // revoke every existing token
    };
    await this.users.update(updated);
    return this.result(updated); // hand back a fresh, valid token
  }

  /** Revoke every outstanding token for the user; returns a fresh one. */
  async logoutEverywhere(userId: string): Promise<AuthResult> {
    const user = await this.users.findById(userId);
    if (!user) throw new AuthError(401, "Session no longer valid.");
    const updated: UserAccount = { ...user, tokenVersion: user.tokenVersion + 1 };
    await this.users.update(updated);
    return this.result(updated);
  }

  /**
   * Verify a bearer token AND that the user still exists with a matching token
   * version. This is the authorization check for every protected request.
   */
  async authenticate(token: string): Promise<{ userId: string }> {
    const { sub, ver } = verifyJwt(token, this.secret);
    const user = await this.users.findById(sub);
    if (!user || user.tokenVersion !== ver) throw new AuthError(401, "Session no longer valid.");
    return { userId: sub };
  }

  private result(user: UserAccount): AuthResult {
    return {
      token: signJwt(user.id, user.tokenVersion, this.secret),
      user: { id: user.id, email: user.email },
    };
  }
}

// ---- Password hashing (scrypt) ---------------------------------------------

function assertPasswordShape(password: string): void {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    throw new AuthError(400, `Password must be at least ${MIN_PASSWORD} characters.`);
  }
  if (password.length > MAX_PASSWORD) {
    throw new AuthError(400, `Password must be at most ${MAX_PASSWORD} characters.`);
  }
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "base64");
  const expected = Buffer.from(parts[2], "base64");
  const derived = await scrypt(password, salt, expected.length);
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

// A fixed hash to compare against for unknown emails (mitigates user enumeration).
const DUMMY_HASH = "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

// ---- Minimal HS256 JWT ------------------------------------------------------

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signJwt(sub: string, ver: number, secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ sub, ver, iat: now, exp: now + TOKEN_TTL_SECONDS }));
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

function verifyJwt(token: string, secret: string): { sub: string; ver: number } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError(401, "Malformed token.");
  const [header, payload, sig] = parts;
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AuthError(401, "Bad token signature.");
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    sub: string;
    ver: number;
    exp: number;
  };
  if (typeof decoded.exp !== "number" || decoded.exp < Math.floor(Date.now() / 1000)) {
    throw new AuthError(401, "Token expired.");
  }
  if (!decoded.sub || typeof decoded.ver !== "number") throw new AuthError(401, "Token missing claims.");
  return { sub: decoded.sub, ver: decoded.ver };
}

// ---- helpers ---------------------------------------------------------------

function normalizeEmail(email: string): string {
  return (email ?? "").trim().toLowerCase();
}
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
