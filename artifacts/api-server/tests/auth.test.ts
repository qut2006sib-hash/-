import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, pool, loginAttemptsTable, sessionsTable, usersTable, vehiclesTable, rideRequestsTable } from "@workspace/db";
import { assertTestDatabase, assertTestMarker } from "@workspace/db/testing";
import { runMigrations } from "@workspace/db/migrations";
import app from "../src/app";
import { DEMO_ACCOUNTS, setupAccounts, setupDemoAccounts } from "../src/lib/accounts";
import { ensureBaseData, resetDynamicData, prepareDemoScenario } from "../src/lib/seed";
import { setClockForTests } from "../src/lib/clock";
import { SESSION_TTL_MS } from "../src/lib/session";
import { errorHandler, HttpError } from "../src/lib/http";
import express from "express";
import * as argon2 from "argon2";

const credentials = Object.fromEntries(DEMO_ACCOUNTS.map((a) => [a.secret, randomBytes(24).toString("hex")]));
const origin = "https://app.test";
const post = (path: string, cookie?: string) => request(app).post(`/api${path}`).set("Host", "app.test").set("Origin", origin).set("Cookie", cookie ?? "")
  .set("Idempotency-Key", randomBytes(16).toString("hex"));
const get = (path: string, cookie?: string) => request(app).get(`/api${path}`).set("Cookie", cookie ?? "");
const login = (name = "passenger-1", password = credentials[DEMO_ACCOUNTS.find((a) => a.key === name)!.secret]) =>
  post("/auth/login").send({ loginName: name, password });
function cookieOf(response: { headers: Record<string, unknown> }) {
  return (response.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
}
async function startProcess(): Promise<{ child: ChildProcess; url: string }> {
  const child = fork(fileURLToPath(new URL("./server.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"], env: process.env,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Test server did not start")); }, 10000);
    child.once("error", reject);
    child.once("message", (message) => {
      clearTimeout(timer);
      resolve({ child, url: `http://127.0.0.1:${(message as { port: number }).port}` });
    });
  });
}
async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill(); });
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== "test" || process.env.SERVICNA_ISOLATED_TESTS !== "1") throw new Error("Use pnpm test with the isolated DB guard");
  assertTestDatabase(process.env.DATABASE_URL, process.env.SERVICNA_DEMO_DATABASE_URL);
  await assertTestMarker(pool, process.env.SERVICNA_DEMO_DATABASE_URL!);
  await runMigrations(pool);
  // This is the sole destructive fixture entry point; the DB identity and
  // marker were checked immediately above, before any cleanup.
  await pool.query("TRUNCATE request_events, ride_requests, trips, vehicles, route_stops, route_directions, routes, sessions, login_attempts, users, app_settings RESTART IDENTITY CASCADE");
  await setupAccounts(credentials);
  await ensureBaseData();
  await resetDynamicData();
});
beforeEach(async () => {
  await db.delete(loginAttemptsTable);
});
afterAll(async () => { await pool.end(); });

describe("test isolation", () => {
  it("rejects the demo database, aliases, and schema-only separation", () => {
    for (const test of ["postgres://a:b@other/demo?options=search_path%3Dtest", "postgres://a:b@h/demo", "postgres://a:b@h/demo_test"]) {
      expect(() => assertTestDatabase(test, test.replace("other", "h"))).toThrow();
    }
    expect(() => assertTestDatabase("postgres://a:b@h/servicna_test", "postgres://a:b@h/demo")).not.toThrow();
  });
  it("rejects an unmarked DB even when its name looks safe", async () => {
    const fake = { query: async () => ({ rows: [{ name: "other_test", marker: null }] }) };
    await expect(assertTestMarker(fake as unknown as typeof pool, "postgres://a:b@h/demo")).rejects.toThrow();
  });
});

describe("accounts and migrations", () => {
  it("uses argon2id, has no phone column and seven enabled accounts", async () => {
    const users = await db.select().from(usersTable);
    expect(users).toHaveLength(7);
    for (const user of users) {
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user.enabled).toBe(true);
      expect(await argon2.verify(user.passwordHash!, credentials[DEMO_ACCOUNTS.find((a) => a.key === user.key)!.secret]!)).toBe(true);
    }
    const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users'");
    expect(columns.rows.map((r) => r.column_name)).not.toContain("phone");
  });
  it("fails before any write if a secret is missing; preserves ids and relationships when rerun", async () => {
    const before = await db.select({ id: usersTable.id, key: usersTable.key }).from(usersTable);
    const vehicles = await db.select().from(vehiclesTable);
    const requests = await db.select().from(rideRequestsTable);
    await expect(setupAccounts({})).rejects.toThrow("DEMO_PASSENGER_1_PASSWORD");
    await setupAccounts(credentials);
    expect(await db.select({ id: usersTable.id, key: usersTable.key }).from(usersTable)).toEqual(before);
    expect(await db.select().from(vehiclesTable)).toEqual(vehicles);
    expect(await db.select().from(rideRequestsTable)).toEqual(requests);
  });
  it("does not change data when migrations are reapplied", async () => {
    const before = await db.select().from(usersTable);
    await runMigrations(pool);
    expect(await db.select().from(usersTable)).toEqual(before);
  });
});

describe("password login and sessions", () => {
  it("rejects account-id-only login and removes public account listing", async () => {
    expect((await post("/session").send({ userId: 1 })).status).toBe(400);
    expect((await get("/demo-accounts")).status).toBe(404);
  });
  it("logs in by password, returns the server role and protects cookie attributes", async () => {
    const response = await login();
    expect(response.status).toBe(200);
    expect(response.body.user.role).toBe("passenger");
    expect(response.body.user.name).toBe("سارة ح.");
    expect(JSON.stringify(response.body)).not.toMatch(/password|hash|phone/i);
    const header = response.headers["set-cookie"][0];
    for (const attribute of ["HttpOnly", "Secure", "SameSite=None", "Partitioned"]) expect(header).toContain(attribute);
    expect((await get("/auth/me", cookieOf(response))).body.authenticated).toBe(true);
  });
  it("stores only a token digest and rotates sessions on repeated login", async () => {
    const first = await login();
    const firstCookie = cookieOf(first);
    const signed = decodeURIComponent(firstCookie.split("=")[1]!);
    const token = signed.slice(2).split(".")[0]!;
    const digest = createHash("sha256").update(token).digest("hex");
    expect(await db.select().from(sessionsTable).where(eq(sessionsTable.tokenHash, digest))).toHaveLength(1);
    const second = await post("/auth/login", firstCookie).send({ loginName: "passenger-1", password: credentials.DEMO_PASSENGER_1_PASSWORD });
    expect(cookieOf(second)).not.toBe(firstCookie);
    expect((await get("/auth/me", firstCookie)).body.authenticated).toBe(false);
    expect((await get("/auth/me", cookieOf(second))).body.authenticated).toBe(true);
  });
  it("returns identical errors for unknown, wrong-password and disabled accounts", async () => {
    const wrong = await login("passenger-1", randomBytes(24).toString("hex"));
    const unknown = await post("/auth/login").send({ loginName: "unknown-user", password: randomBytes(24).toString("hex") });
    const valid = await login("passenger-2");
    await db.update(usersTable).set({ enabled: false }).where(eq(usersTable.key, "passenger-2"));
    const disabled = await login("passenger-2");
    expect(disabled.body).toEqual(wrong.body);
    expect(unknown.body).toEqual(wrong.body);
    expect(disabled.status).toBe(401);
    expect((await get("/auth/me", cookieOf(valid))).body.authenticated).toBe(false);
    await db.update(usersTable).set({ enabled: true }).where(eq(usersTable.key, "passenger-2"));
  });
  it("returns 429 after five failures, with a test-injected clock for cooldown", async () => {
    const restore = setClockForTests({ now: () => new Date("2030-01-01T00:00:00Z") });
    try {
      for (let i = 0; i < 5; i++) expect((await login("passenger-1", "incorrect-test-input")).status).toBe(401);
      expect((await login()).status).toBe(429);
      const restoreLater = setClockForTests({ now: () => new Date("2030-01-01T00:16:00Z") });
      try { expect((await login()).status).toBe(200); } finally { restoreLater(); }
    } finally { restore(); }
  });
  it("enforces session expiry using the internal clock", async () => {
    const time = new Date("2031-01-01T00:00:00Z");
    const restore = setClockForTests({ now: () => time });
    let cookie: string;
    try { cookie = cookieOf(await login()); } finally { restore(); }
    const restoreExpired = setClockForTests({ now: () => new Date(time.getTime() + SESSION_TTL_MS + 1) });
    try { expect((await get("/auth/me", cookie!)).body.authenticated).toBe(false); } finally { restoreExpired(); }
  });
  it("persists across actual process restart; logout invalidates replayed cookies", async () => {
    const beforeUsers = await db.select().from(usersTable);
    const beforeRequests = await db.select().from(rideRequestsTable);
    const first = await startProcess();
    let cookie: string;
    try {
      const response = await request(first.url).post("/api/auth/login").set("Host", "app.test").set("Origin", origin)
        .send({ loginName: "passenger-1", password: credentials.DEMO_PASSENGER_1_PASSWORD });
      expect(response.status).toBe(200);
      cookie = cookieOf(response);
    } finally { await stopProcess(first.child); }
    const second = await startProcess();
    try {
      const api = request(second.url);
      expect((await api.get("/api/auth/me").set("Cookie", cookie!)).body.authenticated).toBe(true);
      expect((await api.post("/api/auth/logout").set("Host", "app.test").set("Origin", origin).set("Cookie", cookie!)).status).toBe(200);
      expect((await api.get("/api/auth/me").set("Cookie", cookie!)).body.authenticated).toBe(false);
    } finally { await stopProcess(second.child); }
    expect(await db.select().from(usersTable)).toEqual(beforeUsers);
    expect(await db.select().from(rideRequestsTable)).toEqual(beforeRequests);
  });
});

describe("server authority, errors and privacy", () => {
  it("rejects missing/foreign/null origins on every mutation, including login and logout", async () => {
    for (const source of [undefined, "https://evil.example", "null"]) {
      let req = request(app).post("/api/auth/login");
      if (source) req = req.set("Origin", source);
      const response = await req.send({ loginName: "passenger-1", password: credentials.DEMO_PASSENGER_1_PASSWORD });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("FORBIDDEN");
    }
    for (const path of ["/auth/logout", "/requests", "/driver/trip", "/admin/reset"]) {
      expect((await request(app).post(`/api${path}`).set("Origin", "https://evil.example")).status).toBe(403);
    }
  });
  it("enforces roles on routes and ignores client role or user-id claims", async () => {
    const passenger = cookieOf(await login());
    expect((await get("/driver/state", passenger)).status).toBe(403);
    expect((await get("/admin/summary", passenger)).status).toBe(403);
    expect((await post("/admin/reset", passenger).send({ role: "admin" })).status).toBe(403);
    expect((await get("/route")).status).toBe(401);
    const driver = cookieOf(await login("driver-2"));
    expect((await get("/passenger/history", driver)).status).toBe(403);
    const forged = await post("/auth/login").send({ loginName: "passenger-1", password: credentials.DEMO_PASSENGER_1_PASSWORD, role: "admin", userId: 7 });
    if (forged.status === 200) expect(forged.body.user.role).toBe("passenger");
    else expect(forged.status).toBe(400);
  });
  it("admits the admin account, but rejects reset outside demo mode", async () => {
    const admin = cookieOf(await login("admin-1"));
    expect((await get("/admin/summary", admin)).status).toBe(200);
    const mode = process.env.DEMO_MODE;
    process.env.DEMO_MODE = "false";
    try {
      const response = await post("/admin/reset", admin).send({});
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("FORBIDDEN");
    } finally {
      if (mode === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = mode;
    }
  });
  it("returns stable Arabic error envelopes for validation, authorization, unknown routes and malformed bodies", async () => {
    const responses = [
      await get("/driver/state"),
      await post("/auth/login").send({}),
      await get("/missing"),
      await post("/auth/login").set("Content-Type", "application/json").send("{broken"),
      await post("/auth/login").send({ loginName: "a", password: "x".repeat(20000) }),
    ];
    for (const response of responses) {
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(Object.keys(response.body).sort()).toEqual(["code", "message"]);
      expect(response.body.code).toMatch(/^[A-Z_]+$/);
      expect(response.body.message).toMatch(/[\u0600-\u06ff]/);
      expect(JSON.stringify(response.body)).not.toMatch(/stack|node_modules|postgres:\/\//);
    }
    expect(new HttpError(403, "غير مسموح").code).toBe("FORBIDDEN");
  });
  it("hides unexpected exception details and stack traces", async () => {
    const broken = express();
    broken.use((req, _res, next) => { req.log = { error: () => {}, warn: () => {} } as unknown as typeof req.log; next(); });
    broken.get("/", () => { throw new Error("private-stack-and-connection-details"); });
    broken.use(errorHandler);
    const response = await request(broken).get("/");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ code: "INTERNAL_ERROR", message: "حدث خطأ غير متوقع في الخادم" });
  });
  it("exposes only stops, id and waiting duration before acceptance; no event/profile leak", async () => {
    await resetDynamicData();
    await prepareDemoScenario();
    const driver = cookieOf(await login("driver-2"));
    const pending = await get("/driver/requests", driver);
    expect(pending.status).toBe(200);
    const item = pending.body.available[0];
    expect(Object.keys(item).sort()).toEqual(["dropoffStop", "id", "pickupStop", "waitingSeconds"]);
    expect(item.waitingSeconds).toBeGreaterThanOrEqual(0);
    expect((await get(`/requests/${item.id}`, driver)).status).toBe(404);
    const other = cookieOf(await login("passenger-1"));
    expect((await get(`/requests/${item.id}`, other)).status).toBe(404);
    const accepted = await post(`/requests/${item.id}/accept`, driver).send({});
    expect(accepted.status).toBe(200);
    expect(accepted.body.passengerName).toBe("ليلى د.");
    expect(JSON.stringify(accepted.body)).not.toMatch(/phone|password/i);
    const owner = cookieOf(await login("passenger-3"));
    const mine = await get("/passenger/active-request", owner);
    expect(mine.body.request).toMatchObject({ driverName: "أبو س.", vehiclePlate: "DEMO-002", vehicleLabel: "مركبة عرض تجريبية — ستة مقاعد" });
    const outsider = cookieOf(await login("driver-3"));
    expect((await get(`/requests/${item.id}`, outsider)).status).toBe(404);
    expect(JSON.stringify(mine.body)).not.toMatch(/phone|password/i);
  });
  it("maps business failures to stable codes", async () => {
    await resetDynamicData();
    await prepareDemoScenario();
    const p = cookieOf(await login("passenger-3"));
    const route = (await get("/route", p)).body;
    const direction = route.directions[0];
    const input = { clientRequestId: randomBytes(16).toString("hex"), directionId: direction.id, pickupStopId: direction.stopIds[0], dropoffStopId: direction.stopIds[5] };
    expect((await post("/requests", p).send(input)).body.code).toBe("ACTIVE_REQUEST_EXISTS");
    expect((await post("/requests", p).send({ ...input, directionId: 9999 })).body.code).toBe("INVALID_DIRECTION");
    const d = cookieOf(await login("driver-2"));
    const pending = (await get("/driver/requests", d)).body.available[0];
    await db.update(rideRequestsTable).set({ expiresAt: new Date(0) }).where(eq(rideRequestsTable.id, pending.id));
    expect((await post(`/requests/${pending.id}/accept`, d).send({})).body.code).toBe("REQUEST_EXPIRED");
  });
});

describe("passwordless demo mode requested by the user", () => {
  let mode: string | undefined;
  beforeAll(async () => {
    mode = process.env.DEMO_MODE;
    process.env.DEMO_MODE = "true";
    await setupDemoAccounts();
  });
  afterAll(() => {
    if (mode === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = mode;
  });

  it("sets up seven demo accounts without secrets and preserves their ids and relationships", async () => {
    const before = await db.select({ id: usersTable.id, key: usersTable.key }).from(usersTable);
    const vehicles = await db.select().from(vehiclesTable);
    const requests = await db.select().from(rideRequestsTable);
    await setupDemoAccounts();
    expect(await db.select({ id: usersTable.id, key: usersTable.key }).from(usersTable)).toEqual(before);
    expect(await db.select().from(vehiclesTable)).toEqual(vehicles);
    expect(await db.select().from(rideRequestsTable)).toEqual(requests);
    expect((await db.select().from(usersTable)).every((u) => u.passwordHash === null && u.enabled)).toBe(true);
  });
  it("offers only the seven allowlisted accounts and logs into each server-owned role without a password", async () => {
    const options = await get("/auth/options");
    expect(options.body.demoMode).toBe(true);
    expect(options.body.accounts).toHaveLength(7);
    for (const account of DEMO_ACCOUNTS) {
      const response = await post("/auth/demo-login").send({ loginName: account.key, role: "admin", userId: 999 });
      expect(response.status).toBe(200);
      expect(response.body.user.role).toBe(account.role);
      expect((await get("/auth/me", cookieOf(response))).body.authenticated).toBe(true);
    }
    expect(JSON.stringify(options.body)).not.toMatch(/password|hash|phone|secret/i);
  });
  it("denies disabled and non-demo accounts, and foreign origins", async () => {
    expect((await post("/auth/demo-login").send({ loginName: "other-account" })).status).toBe(401);
    await db.update(usersTable).set({ enabled: false }).where(eq(usersTable.key, "passenger-2"));
    try {
      expect((await post("/auth/demo-login").send({ loginName: "passenger-2" })).status).toBe(401);
      expect((await get("/auth/options")).body.accounts.some((a: { loginName: string }) => a.loginName === "passenger-2")).toBe(false);
    } finally { await db.update(usersTable).set({ enabled: true }).where(eq(usersTable.key, "passenger-2")); }
    expect((await request(app).post("/api/auth/demo-login").set("Origin", "https://evil.example").send({ loginName: "admin-1" })).status).toBe(403);
  });
  it("disabling demo mode blocks passwordless login, its sessions, account listing and setup", async () => {
    const cookie = cookieOf(await post("/auth/demo-login").send({ loginName: "passenger-1" }));
    process.env.DEMO_MODE = "false";
    try {
      expect((await get("/auth/options")).body).toEqual({ demoMode: false, accounts: [] });
      expect((await post("/auth/demo-login").send({ loginName: "admin-1" })).status).toBe(403);
      expect((await get("/auth/me", cookie)).body.authenticated).toBe(false);
      await expect(setupDemoAccounts()).rejects.toThrow("DEMO_MODE=true");
    } finally { process.env.DEMO_MODE = "true"; }
  });
  it("post-merge initialization does not reactivate disabled accounts or revoke existing sessions", async () => {
    const cookie = cookieOf(await post("/auth/demo-login").send({ loginName: "passenger-1" }));
    await db.update(usersTable).set({ enabled: false }).where(eq(usersTable.key, "passenger-2"));
    try {
      await setupDemoAccounts(true);
      expect((await get("/auth/me", cookie)).body.authenticated).toBe(true);
      expect((await post("/auth/demo-login").send({ loginName: "passenger-2" })).status).toBe(401);
    } finally { await db.update(usersTable).set({ enabled: true }).where(eq(usersTable.key, "passenger-2")); }
  });
  it("persists a demo session through actual restart and revokes it at logout", async () => {
    const first = await startProcess();
    let cookie: string;
    try {
      const response = await request(first.url).post("/api/auth/demo-login").set("Host", "app.test").set("Origin", origin).send({ loginName: "driver-1" });
      expect(response.status).toBe(200);
      cookie = cookieOf(response);
    } finally { await stopProcess(first.child); }
    const second = await startProcess();
    try {
      const api = request(second.url);
      expect((await api.get("/api/auth/me").set("Cookie", cookie!)).body.user.role).toBe("driver");
      expect((await api.post("/api/auth/logout").set("Host", "app.test").set("Origin", origin).set("Cookie", cookie!)).status).toBe(200);
      expect((await api.get("/api/auth/me").set("Cookie", cookie!)).body.authenticated).toBe(false);
    } finally { await stopProcess(second.child); }
  });
});
