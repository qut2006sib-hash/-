import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { db, pool, rideRequestsTable, requestEventsTable, tripsTable, usersTable, vehiclesTable } from "@workspace/db";
import { assertTestDatabase, assertTestMarker } from "@workspace/db/testing";
import { runMigrations } from "@workspace/db/migrations";
import app from "../src/app";
import { setupDemoAccounts } from "../src/lib/accounts";
import { ensureBaseData, resetDynamicData, prepareDemoScenario } from "../src/lib/seed";
import { eq } from "drizzle-orm";

const post = (path: string, cookie = "") => request(app).post(`/api${path}`)
  .set("Host", "app.test").set("Origin", "https://app.test").set("Cookie", cookie).set("Idempotency-Key", randomUUID());
const get = (path: string, cookie = "") => request(app).get(`/api${path}`).set("Cookie", cookie);
const cookieOf = (r: { headers: Record<string, unknown> }) => (r.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
const login = async (loginName: string) => cookieOf(await post("/auth/demo-login").send({ loginName }));

beforeAll(async () => {
  assertTestDatabase(process.env.DATABASE_URL, process.env.SERVICNA_DEMO_DATABASE_URL);
  await assertTestMarker(pool, process.env.SERVICNA_DEMO_DATABASE_URL!);
  await runMigrations(pool);
  await pool.query("TRUNCATE request_events, ride_requests, trips, vehicles, route_stops, route_directions, routes, sessions, login_attempts, users, app_settings RESTART IDENTITY CASCADE");
  await setupDemoAccounts();
  await ensureBaseData();
});
beforeEach(async () => { await resetDynamicData(); });
afterAll(async () => { await pool.end(); });

async function planner(cookie: string) {
  const route = (await get("/route", cookie)).body;
  const d = route.directions[0];
  return { route, input: { clientRequestId: randomUUID(), directionId: d.id, pickupStopId: d.stopIds[0], dropoffStopId: d.stopIds[5] } };
}
async function startProcess() {
  const child = fork(fileURLToPath(new URL("./server.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"], env: process.env,
  });
  return new Promise<{ child: ChildProcess; url: string }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("server timeout")); }, 10000);
    child.once("error", (err) => { clearTimeout(timer); reject(err); });
    child.once("message", (m) => {
      clearTimeout(timer); resolve({ child, url: `http://127.0.0.1:${(m as { port: number }).port}` });
    });
  });
}
async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill(); });
}

describe("reference data, demo actions and API matching", () => {
  it("starts empty with seven accounts, three enabled 6-seat DEMO vehicles and independent six-stop geometries", async () => {
    const users = await db.select().from(usersTable);
    expect(users.filter((u) => u.role === "passenger")).toHaveLength(3);
    expect(users.filter((u) => u.role === "driver")).toHaveLength(3);
    expect(users.filter((u) => u.role === "admin")).toHaveLength(1);
    const vehicles = await db.select().from(vehiclesTable);
    expect(vehicles.map((v) => v.plate).sort()).toEqual(["DEMO-001", "DEMO-002", "DEMO-003"]);
    expect(vehicles.every((v) => v.capacity === 6 && v.enabled && v.description.length > 0)).toBe(true);
    expect(await db.select().from(tripsTable)).toHaveLength(0);
    expect(await db.select().from(rideRequestsTable)).toHaveLength(0);
    const { route } = await planner(await login("passenger-1"));
    expect(route.stops).toHaveLength(12);
    expect(route.directions).toHaveLength(2);
    for (const d of route.directions) {
      expect(d.stopIds).toHaveLength(6);
      expect(d.geometry).toHaveLength(6);
      expect(route.stops.filter((s: { directionId: number }) => s.directionId === d.id).map((s: { name: string }) => s.name))
        .toEqual(Array.from({ length: 6 }, (_, i) => `نقطة تجريبية ${i + 1}`));
    }
    expect(route.directions[0].geometry).not.toEqual([...route.directions[1].geometry].reverse());
  });
  it("separates prepare/reset/account setup, refuses destructive prepare and enforces roles/demo mode", async () => {
    const p = await login("passenger-1");
    expect((await post("/admin/prepare", p)).status).toBe(403);
    const a = await login("admin-1");
    expect((await post("/admin/prepare", a)).status).toBe(200);
    const before = await db.select().from(rideRequestsTable);
    expect(before).toHaveLength(1);
    expect(await db.select().from(tripsTable)).toHaveLength(2);
    expect((await post("/admin/prepare", a)).status).toBe(409);
    await ensureBaseData();
    expect(await db.select().from(rideRequestsTable)).toEqual(before);
    const accountIds = (await db.select().from(usersTable)).map((u) => u.id);
    expect((await post("/admin/reset", a)).status).toBe(200);
    expect(await db.select().from(rideRequestsTable)).toHaveLength(0);
    expect(await db.select().from(tripsTable)).toHaveLength(0);
    expect((await db.select().from(usersTable)).map((u) => u.id)).toEqual(accountIds);
    process.env.DEMO_MODE = "false";
    try { await expect(prepareDemoScenario()).rejects.toThrow(); await expect(resetDynamicData()).rejects.toThrow(); }
    finally { process.env.DEMO_MODE = "true"; }
  });
  it("A03 gives exact outside/no-service messages and manual matching without GPS or distances", async () => {
    const cookie = await login("passenger-1");
    const { route, input } = await planner(cookie);
    const valid = await post("/route/suggest", cookie).send({ mode: "manual", pickupStopId: input.pickupStopId, dropoffStopId: input.dropoffStopId });
    expect(valid.status).toBe(200);
    expect(valid.body.note).toBe("الخط مناسب، ولا يوجد سرفيس متاح الآن");
    expect(valid.body.suggestions).toHaveLength(1);
    expect(valid.body.suggestions[0].walkToPickupMeters).toBeNull();
    const origin = route.stops[0];
    const outside = await post("/route/suggest", cookie).send({ mode: "coordinates", originLat: origin.lat, originLng: origin.lng, destinationLat: 35.5, destinationLng: 38 });
    expect(outside.body).toEqual({ suggestions: [], note: "الوجهة خارج نطاق الخط التجريبي" });
    expect((await post("/route/suggest", cookie).send({ mode: "coordinates" })).status).toBe(400);
    expect((await post("/route/suggest", cookie).send({ mode: "manual", pickupStopId: input.dropoffStopId, dropoffStopId: input.pickupStopId })).body.suggestions).toEqual([]);
  });
});

describe("A05–A06 request creation, restoration and single active request", () => {
  it("persists a pending unassigned request and unchanged meeting point through actual server restart", async () => {
    const first = await startProcess();
    let cookie = "", id = 0, pickup = 0;
    try {
      cookie = cookieOf(await request(first.url).post("/api/auth/demo-login").set("Host", "app.test")
        .set("Origin", "https://app.test").send({ loginName: "passenger-1" }));
      const { input } = await planner(cookie);
      pickup = input.pickupStopId;
      const created = await request(first.url).post("/api/requests").set("Cookie", cookie).set("Host", "app.test")
        .set("Origin", "https://app.test").set("Idempotency-Key", randomUUID()).send(input);
      expect(created.status).toBe(200);
      expect(created.body).toMatchObject({ status: "pending", tripId: null, driverName: null, pickupStop: { id: pickup } });
      id = created.body.id;
    } finally { await stopProcess(first.child); }
    const before = await db.select().from(rideRequestsTable);
    const second = await startProcess();
    try {
      const active = await request(second.url).get("/api/passenger/active-request").set("Cookie", cookie);
      expect(active.status).toBe(200);
      expect(active.body).toMatchObject({ hasActive: true, request: { id, pickupStop: { id: pickup }, status: "pending", tripId: null } });
      expect(active.body.events).toHaveLength(1);
    } finally { await stopProcess(second.child); }
    expect(await db.select().from(rideRequestsTable)).toEqual(before);
  });
  it("rejects duplicate active requests, including concurrent creates, without duplicate events", async () => {
    const cookie = await login("passenger-1");
    const { input } = await planner(cookie);
    const keys = [randomUUID(), randomUUID()];
    const results = await Promise.all(keys.map((key) => post("/requests", cookie).set("Idempotency-Key", key).send(input)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe("ACTIVE_REQUEST_EXISTS");
    const [active] = await db.select().from(rideRequestsTable);
    expect(await db.select().from(requestEventsTable)).toHaveLength(1);
    const retry = await post("/requests", cookie).set("Idempotency-Key", keys[results.findIndex((r) => r.status === 200)]!).send(input);
    expect(retry.body.id).toBe(active!.id);
    expect(await db.select().from(requestEventsTable)).toHaveLength(1);
    expect((await post("/requests", cookie).send({ ...input, clientRequestId: randomUUID() })).body.code).toBe("ACTIVE_REQUEST_EXISTS");
    expect((await post(`/requests/${active!.id}/cancel`, cookie)).status).toBe(200);
    expect((await post("/requests", cookie).send({ ...input, clientRequestId: randomUUID() })).status).toBe(200);
  });
  it("enforces sequence/direction server-side and paginates only the owner's requests stably", async () => {
    const cookie = await login("passenger-1");
    const { input, route } = await planner(cookie);
    expect((await post("/requests", cookie).send({ ...input, dropoffStopId: input.pickupStopId })).status).toBe(400);
    expect((await post("/requests", cookie).send({ ...input, pickupStopId: input.dropoffStopId, dropoffStopId: input.pickupStopId })).status).toBe(400);
    expect((await post("/requests", cookie).send({ ...input, dropoffStopId: route.directions[1].stopIds[5] })).status).toBe(400);
    for (let i = 0; i < 5; i++) {
      const r = await post("/requests", cookie).send({ ...input, clientRequestId: randomUUID() });
      expect(r.status).toBe(200);
      await post(`/requests/${r.body.id}/cancel`, cookie);
    }
    const pages = await Promise.all([1, 2, 3].map((p) => get(`/passenger/history?page=${p}&pageSize=2`, cookie)));
    expect(pages[0]!.body).toMatchObject({ page: 1, pageSize: 2, total: 5, totalPages: 3 });
    const ids = pages.flatMap((p) => p.body.items.map((r: { id: number }) => r.id));
    expect(new Set(ids).size).toBe(5);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    const other = await login("passenger-2");
    expect((await get("/passenger/history", other)).body.total).toBe(0);
    expect((await get("/passenger/history?page=0", cookie)).status).toBe(400);
    expect((await get("/passenger/history?pageSize=51", cookie)).status).toBe(400);
    // No public API can move the meeting point after creation.
    const [r] = await db.select().from(rideRequestsTable);
    expect((await request(app).patch(`/api/requests/${r!.id}`).set("Host", "app.test").set("Origin", "https://app.test")
      .set("Cookie", cookie).send({ pickupStopId: input.dropoffStopId })).status).toBe(404);
    expect((await db.select().from(rideRequestsTable).where(eq(rideRequestsTable.id, r!.id)))[0]!.pickupStopId).toBe(input.pickupStopId);
  });
  it("keeps the single-active constraint for accepted AND boarded requests", async () => {
    const cookie = await login("passenger-1");
    const driver = await login("driver-1");
    const { input } = await planner(cookie);
    expect((await post("/driver/trip", driver).send({ directionId: input.directionId })).status).toBe(200);
    const created = await post("/requests", cookie).send(input);
    expect((await post(`/requests/${created.body.id}/accept`, driver)).status).toBe(200);
    const another = () => post("/requests", cookie).send({ ...input, clientRequestId: randomUUID() });
    expect((await another()).body.code).toBe("ACTIVE_REQUEST_EXISTS");
    // Internal fixture only: boarding ownership is implemented by a separate task.
    await db.update(rideRequestsTable).set({ status: "boarded", boardedAt: new Date() }).where(eq(rideRequestsTable.id, created.body.id));
    expect((await another()).body.code).toBe("ACTIVE_REQUEST_EXISTS");
    expect((await get("/passenger/active-request", cookie)).body.request.pickupStop.id).toBe(input.pickupStopId);
  });
});
