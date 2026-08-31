import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { User } from "@/lib/types";

// Mock auth for the exercise — no real identity provider, no database.
//
// Tokens are opaque-to-the-client, HMAC-SHA256 signed strings shaped like a JWT without the
// header segment: `base64url(payload).base64url(signature)`. A real JWT library would be the
// production answer; hand-rolling it here keeps the dependency list honest and makes the
// verification rules (signature, expiry, and *type*) explicit for the review.
//
// The signing secret is read from the environment when present so tokens survive a restart in a
// deployed setting, and falls back to a per-process random secret so `npm run dev` needs zero
// setup. A restart therefore invalidates outstanding tokens — acceptable, since the job/run store
// is in-memory and gets wiped by the same restart.
const SECRET = process.env.ENCODR_TOKEN_SECRET ?? randomBytes(32).toString("hex");

/** Deliberately short so the client's silent-refresh path is exercised during a normal session. */
export const ACCESS_TOKEN_TTL_SEC = 60;
export const REFRESH_TOKEN_TTL_SEC = 60 * 60 * 24 * 7;

type TokenType = "access" | "refresh";

interface TokenPayload {
  sub: string;
  typ: TokenType;
  exp: number; // epoch seconds
}

// The one hard-coded user. Documented in the README.
const USERS: (User & { password: string })[] = [
  { id: "u_demo", email: "demo@encodr.dev", name: "Demo User", password: "password123" },
];

export function authenticate(email: string, password: string): User | null {
  const user = USERS.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (!user || user.password !== password) return null;
  const { password: _pw, ...safe } = user;
  return safe;
}

export function findUser(id: string): User | null {
  const user = USERS.find((u) => u.id === id);
  if (!user) return null;
  const { password: _pw, ...safe } = user;
  return safe;
}

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("base64url");
}

function encode(payload: TokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

/**
 * Verify signature, expiry, and token type. Exported for tests; routes should use the
 * intent-revealing wrappers below.
 */
export function verifyToken(
  token: string,
  expectedType: TokenType,
  now: number = Date.now(),
): TokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!body || !signature) return null;

  const expected = Buffer.from(sign(body));
  const actual = Buffer.from(signature);
  // timingSafeEqual throws on a length mismatch, so compare lengths first.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
  } catch {
    return null;
  }

  if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
  // A refresh token must never be usable as an access token (or vice versa).
  if (payload.typ !== expectedType) return null;
  if (payload.exp * 1000 <= now) return null;

  return payload;
}

function mint(userId: string, typ: TokenType, ttlSec: number, now: number): string {
  return encode({ sub: userId, typ, exp: Math.floor(now / 1000) + ttlSec });
}

export function issueTokens(
  userId: string,
  now: number = Date.now(),
): { accessToken: string; refreshToken: string } {
  return {
    accessToken: mint(userId, "access", ACCESS_TOKEN_TTL_SEC, now),
    refreshToken: mint(userId, "refresh", REFRESH_TOKEN_TTL_SEC, now),
  };
}

export function issueAccessToken(userId: string, now: number = Date.now()): string {
  return mint(userId, "access", ACCESS_TOKEN_TTL_SEC, now);
}

/**
 * Return the authenticated userId from the request, or null.
 *
 * Bearer header only — including for the SSE stream, which the client opens with
 * `@microsoft/fetch-event-source` rather than native `EventSource` precisely so it can set this
 * header. See the README for why that beats a query-param token.
 */
export function getUserIdFromRequest(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;

  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;

  return verifyToken(token, "access")?.sub ?? null;
}

/** Verify a refresh token and return its subject (userId), or null. */
export function verifyRefreshToken(token: string): string | null {
  return verifyToken(token, "refresh")?.sub ?? null;
}
