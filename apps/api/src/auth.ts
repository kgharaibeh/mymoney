/**
 * Authentication: email/password signup + login, password hashing, and
 * stateless bearer tokens. Zero external dependencies — password hashing uses
 * Node's scrypt KDF and tokens are HS256 JWTs signed with node:crypto.
 *
 * Passwords are never stored or logged in plaintext; only the scrypt digest
 * (with a per-user random salt) is persisted.
 */

import { createHmac, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { UserAccount, UserRepository } from "@mymoney/domain";

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const KEYLEN = 64;
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

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

export class AuthService {
  constructor(
    private readonly users: UserRepository,
    private readonly secret: string,
  ) {}

  async signup(input: AuthInput): Promise<AuthResult> {
    const email = normalizeEmail(input.email);
    if (!isValidEmail(email)) throw new AuthError(400, "Enter a valid email address.");
    if (!input.password || input.password.length < 8) {
      throw new AuthError(400, "Password must be at least 8 characters.");
    }
    if (await this.users.findByEmail(email)) {
      throw new AuthError(409, "An account with that email already exists.");
    }
    const user: UserAccount = {
      id: randomUUID(),
      email,
      passwordHash: await hashPassword(input.password),
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
    const user = await this.users.findByEmail(email);
    // Verify even when the user is missing to keep timing uniform-ish.
    const ok = user
      ? await verifyPassword(input.password, user.passwordHash)
      : await verifyPassword(input.password, DUMMY_HASH).then(() => false);
    if (!user || !ok) throw new AuthError(401, "Incorrect email or password.");
    return this.result(user);
  }

  async me(userId: string): Promise<{ id: string; email: string }> {
    const user = await this.users.findById(userId);
    if (!user) throw new AuthError(401, "Session no longer valid.");
    return { id: user.id, email: user.email };
  }

  /** Verify a bearer token and return the subject (user id), or throw. */
  verifyToken(token: string): { sub: string } {
    return verifyJwt(token, this.secret);
  }

  private result(user: UserAccount): AuthResult {
    return { token: signJwt(user.id, this.secret), user: { id: user.id, email: user.email } };
  }
}

// ---- Password hashing (scrypt) ---------------------------------------------

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

function signJwt(sub: string, secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ sub, iat: now, exp: now + TOKEN_TTL_SECONDS }));
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

function verifyJwt(token: string, secret: string): { sub: string } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError(401, "Malformed token.");
  const [header, payload, sig] = parts;
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AuthError(401, "Bad token signature.");
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub: string; exp: number };
  if (typeof decoded.exp !== "number" || decoded.exp < Math.floor(Date.now() / 1000)) {
    throw new AuthError(401, "Token expired.");
  }
  if (!decoded.sub) throw new AuthError(401, "Token missing subject.");
  return { sub: decoded.sub };
}

// ---- helpers ---------------------------------------------------------------

function normalizeEmail(email: string): string {
  return (email ?? "").trim().toLowerCase();
}
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
