import { Router, type IRouter } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { DemoSignInBody, GetAuthOptionsResponse, GetSessionResponse, SignInBody, SignInResponse, SignOutResponse } from "@workspace/api-zod";
import { HttpError } from "../lib/http";
import { loadRefs, serializeUser } from "../lib/domain";
import { createSession, destroySession } from "../lib/session";
import { clearLoginFailures, limitLogin, verifyPassword } from "../lib/login";
import { DEMO_ACCOUNTS } from "../lib/accounts";

const router: IRouter = Router();

router.get("/auth/options", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const demoMode = process.env.DEMO_MODE === "true";
  if (!demoMode) {
    res.json(GetAuthOptionsResponse.parse({ demoMode: false, accounts: [] }));
    return;
  }
  const users = await db.select().from(usersTable).where(and(
    inArray(usersTable.key, DEMO_ACCOUNTS.map((a) => a.key)),
    eq(usersTable.enabled, true),
  ));
  const accounts = DEMO_ACCOUNTS.flatMap((account) => {
    const user = users.find((u) => u.key === account.key && u.loginName === account.key && u.role === account.role);
    return user ? [{ loginName: user.loginName, name: user.name, role: user.role }] : [];
  });
  res.json(GetAuthOptionsResponse.parse({ demoMode, accounts }));
});

router.post("/auth/demo-login", async (req, res) => {
  if (process.env.DEMO_MODE !== "true") throw new HttpError(403, "الدخول التجريبي بدون كلمة مرور غير مفعّل", "FORBIDDEN");
  const { loginName } = DemoSignInBody.parse(req.body);
  await limitLogin(req.ip ?? "unknown", loginName);
  const account = DEMO_ACCOUNTS.find((a) => a.key === loginName);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.loginName, loginName));
  if (!account || !user || !user.enabled || user.key !== account.key || user.role !== account.role) {
    throw new HttpError(401, "الحساب التجريبي غير متاح أو غير مفعّل", "INVALID_CREDENTIALS");
  }
  await clearLoginFailures(loginName);
  await createSession(req, res, user.id, "demo");
  res.set("Cache-Control", "no-store");
  const refs = await loadRefs();
  res.json(SignInResponse.parse({ authenticated: true, user: serializeUser(user, refs) }));
});

router.get(["/auth/me", "/session"], async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!req.user) {
    res.json(GetSessionResponse.parse({ authenticated: false }));
    return;
  }
  const refs = await loadRefs();
  res.json(GetSessionResponse.parse({ authenticated: true, user: serializeUser(req.user, refs) }));
});

router.post(["/auth/login", "/session"], async (req, res) => {
  const { loginName, password } = SignInBody.parse(req.body);
  await limitLogin(req.ip ?? "unknown", loginName);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.loginName, loginName));
  const valid = await verifyPassword(user?.passwordHash, password);
  if (!user || !user.enabled || !user.passwordHash || !valid) {
    throw new HttpError(401, "اسم الدخول أو كلمة المرور غير صحيحين، أو الحساب غير مفعّل", "INVALID_CREDENTIALS");
  }
  await clearLoginFailures(loginName);
  await createSession(req, res, user.id);
  res.set("Cache-Control", "no-store");
  const refs = await loadRefs();
  res.json(SignInResponse.parse({ authenticated: true, user: serializeUser(user, refs) }));
});

router.post("/auth/logout", async (req, res) => {
  await destroySession(req, res);
  res.json(SignOutResponse.parse({ authenticated: false }));
});
// Compatibility for old clients; still origin checked and revokes the DB row.
router.delete("/session", async (req, res) => {
  await destroySession(req, res);
  res.json(SignOutResponse.parse({ authenticated: false }));
});
export default router;
