import { createHash, randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { and, eq, gt } from "drizzle-orm";
import { db, sessionsTable, usersTable, type DbUser } from "@workspace/db";
import { HttpError } from "./http";
import { now } from "./clock";

export const SESSION_COOKIE = "servicna_sid";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
type Role = DbUser["role"];

declare global {
  namespace Express {
    interface Request {
      user?: DbUser;
      sessionHash?: string;
    }
  }
}

// None is required for the private cross-site preview. Strict Origin checks on
// every mutation compensate for cross-site cookies; no wildcard credential CORS.
const cookieOptions = {
  httpOnly: true,
  signed: true,
  sameSite: "none" as const,
  secure: true,
  partitioned: true,
  path: "/",
};
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(req: Request, res: Response, userId: number, authMethod: "password" | "demo" = "password"): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    if (req.sessionHash) await tx.delete(sessionsTable).where(eq(sessionsTable.tokenHash, req.sessionHash));
    await tx.insert(sessionsTable).values({
      tokenHash: hashToken(token), userId, authMethod, createdAt: now(),
      expiresAt: new Date(now().getTime() + SESSION_TTL_MS),
    });
  });
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: SESSION_TTL_MS });
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  if (req.sessionHash) await db.delete(sessionsTable).where(eq(sessionsTable.tokenHash, req.sessionHash));
  res.clearCookie(SESSION_COOKIE, cookieOptions);
}

export async function loadSessionUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.signedCookies?.[SESSION_COOKIE];
    if (typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token)) {
      req.sessionHash = hashToken(token);
      const [row] = await db.select({ user: usersTable, authMethod: sessionsTable.authMethod }).from(sessionsTable)
        .innerJoin(usersTable, eq(usersTable.id, sessionsTable.userId))
        .where(and(eq(sessionsTable.tokenHash, req.sessionHash), gt(sessionsTable.expiresAt, now()), eq(usersTable.enabled, true)));
      if (row && (row.authMethod !== "demo" || process.env.DEMO_MODE === "true")) req.user = row.user;
    }
    next();
  } catch (err) { next(err); }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(new HttpError(401, "يجب تسجيل الدخول أولًا"));
    if (roles.length && !roles.includes(req.user.role)) return next(new HttpError(403, "لا تملك صلاحية لهذه العملية"));
    next();
  };
}

export function currentUser(req: Request): DbUser {
  if (!req.user) throw new HttpError(401, "يجب تسجيل الدخول أولًا");
  return req.user;
}
