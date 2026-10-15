import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "receptionist_session";
const MAX_AGE_S = 60 * 60 * 24 * 30;

function secret(): string {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  if (process.env.NODE_ENV === "production") throw new Error("Set AUTH_SECRET in production.");
  return "receptionist-local-dev-secret";
}

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

/** "<userId>.<expiresAtSeconds>.<hmac>" */
export function createSessionToken(userId: string, nowMs = Date.now()): string {
  const payload = `${userId}.${Math.floor(nowMs / 1000) + MAX_AGE_S}`;
  return `${payload}.${sign(payload)}`;
}

export function readSessionToken(token: string | undefined, nowMs = Date.now()): string | null {
  if (!token) return null;
  const cut = token.lastIndexOf(".");
  if (cut < 0) return null;
  const payload = token.slice(0, cut);
  const given = Buffer.from(token.slice(cut + 1));
  const expected = Buffer.from(sign(payload));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const dot = payload.lastIndexOf(".");
  const userId = payload.slice(0, dot);
  const exp = Number(payload.slice(dot + 1));
  return userId && Number.isFinite(exp) && exp * 1000 > nowMs ? userId : null;
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: MAX_AGE_S,
};
