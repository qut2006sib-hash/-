import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  db, pool, idempotencyRecordsTable, requestEventsTable, rideRequestsTable, tripsTable, usersTable, vehiclesTable,
} from "@workspace/db";
import { assertTestDatabase, assertTestMarker } from "@workspace/db/testing";
import { runMigrations } from "@workspace/db/migrations";
import app from "../src/app";
import { setupDemoAccounts } from "../src/lib/accounts";
import { ensureBaseData, resetDynamicData } from "../src/lib/seed";
import { setClockForTests } from "../src/lib/clock";
import { expireStaleRequests } from "../src/lib/domain";

const origin = "https://app.test";
const post = (path: string, cookie = "", key = randomUUID()) => request(app).post(`/api${path}`)
  .set("Host", "app.test").set("Origin", origin).set("Cookie", cookie).set("Idempotency-Key", key);
const patch = (path: string, cookie: string, key = randomUUID()) => request(app).patch(`/api${path}`)
  .set("Host", "app.test").set("Origin", origin).set("Cookie", cookie).set("Idempotency-Key", key);
const get = (path: string, cookie: string) => request(app).get(`/api${path}`).set("Cookie", cookie);
const login = async (loginName: string) => {
  const r = await post("/auth/demo-login").send({ loginName });
  expect(r.status).toBe(200);
  return r.headers["set-cookie"][0]!.split(";")[0]!;
};
let passengers: string[], drivers: string[], admin: string, direction: number, otherDirection: number, stops: number[];
let restoreClock: (() => void) | undefined;
let instant: number;
const tick = (ms: number) => { instant += ms; };
const input = (pickup = 2) => ({ directionId: direction, pickupStopId: stops[pickup], dropoffStopId: stops[5] });
async function create(p = 0, pickup = 2) {
  const r = await post("/requests", passengers[p]).send(input(pickup));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
async function start(d = 0, externalOccupied = 0) {
  const r = await post("/driver/trip", drivers[d]).send({ directionId: direction, externalOccupied });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
const events = (id: number, status: string) => db.select().from(requestEventsTable).where(and(
  eq(requestEventsTable.requestId, id), eq(requestEventsTable.toStatus, status),
));
async function assertCapacity(id: number) {
  const [trip] = await db.select().from(tripsTable).where(eq(tripsTable.id, id));
  const rows = await db.select().from(rideRequestsTable).where(eq(rideRequestsTable.tripId, id));
  expect(trip!.reservedSeats).toBe(rows.filter((r) => r.status === "accepted").length);
  expect(trip!.boardedSeats).toBe(rows.filter((r) => r.status === "boarded").length);
  expect(trip!.externalOccupied + trip!.reservedSeats + trip!.boardedSeats).toBeLessThanOrEqual(trip!.capacitySnapshot);
  expect(trip!.seatsTaken).toBe(trip!.reservedSeats + trip!.boardedSeats);
  return trip!;
}

beforeAll(async () => {
  assertTestDatabase(process.env.DATABASE_URL, process.env.SERVICNA_DEMO_DATABASE_URL);
  await assertTestMarker(pool, process.env.SERVICNA_DEMO_DATABASE_URL!);
  await runMigrations(pool);
  await pool.query("TRUNCATE idempotency_records, request_events, ride_requests, trips, vehicles, route_stops, route_directions, routes, sessions, login_attempts, users, app_settings RESTART IDENTITY CASCADE");
  await setupDemoAccounts(); await ensureBaseData();
});
beforeEach(async () => {
  await resetDynamicData();
  await pool.query("TRUNCATE login_attempts"); // isolate rate limiting from business-rule tests
  instant = Date.now(); restoreClock = setClockForTests({ now: () => new Date(instant) });
  passengers = await Promise.all([1, 2, 3].map((i) => login(`passenger-${i}`)));
  drivers = await Promise.all([1, 2].map((i) => login(`driver-${i}`)));
  admin = await login("admin-1");
  const route = (await get("/route", admin)).body;
  direction = route.directions[0].id; otherDirection = route.directions[1].id; stops = route.directions[0].stopIds;
});
afterEach(() => { restoreClock?.(); process.env.DEMO_MODE = "true"; });
afterAll(async () => { await pool.end(); });

describe("real PostgreSQL concurrent requests (A07–A11)", () => {
  it("A07: two drivers, one acceptance and one acceptance event", async () => {
    const [a, b, r] = await Promise.all([start(0), start(1), create()]);
    const results = await Promise.all(drivers.map((d) => post(`/requests/${r.id}/accept`, d)));
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(results.find((x) => x.status === 409)!.body.code).toBe("REQUEST_TAKEN");
    expect(await events(r.id, "accepted")).toHaveLength(1);
    await assertCapacity(a.id); await assertCapacity(b.id);
  });
  it("A08: two requests compete for the last seat", async () => {
    const trip = await start(0, 5), a = await create(0), b = await create(1);
    const results = await Promise.all([a, b].map((r) => post(`/requests/${r.id}/accept`, drivers[0])));
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(results.find((x) => x.status === 409)!.body.code).toBe("NO_CAPACITY");
    const t = await assertCapacity(trip.id);
    expect(t.reservedSeats).toBe(1);
    const pending = await db.select().from(rideRequestsTable).where(eq(rideRequestsTable.status, "pending"));
    expect(pending).toHaveLength(1);
  });
  it("A09: concurrent accept/cancel preserves one final state and capacity", async () => {
    const trip = await start(), r = await create();
    const [accept, cancel] = await Promise.all([
      post(`/requests/${r.id}/accept`, drivers[0]), post(`/requests/${r.id}/cancel`, passengers[0]),
    ]);
    expect([200, 409]).toContain(accept.status); expect(cancel.status).toBe(200);
    const detail = await get(`/requests/${r.id}`, admin);
    expect(detail.body.request.status).toBe("cancelled");
    expect(await events(r.id, "cancelled")).toHaveLength(1);
    expect((await assertCapacity(trip.id)).reservedSeats).toBe(0);
  });
  it("concurrent identical keys commit one result, one event and one record", async () => {
    const trip = await start(), r = await create(), key = randomUUID();
    const pair = await Promise.all([1, 2].map(() => post(`/requests/${r.id}/accept`, drivers[0], key).send({})));
    expect(pair.map((x) => x.status)).toEqual([200, 200]);
    expect(pair.map((x) => x.body.replayed).sort()).toEqual([false, true]);
    expect(pair[0]!.body.id).toBe(pair[1]!.body.id);
    expect(await events(r.id, "accepted")).toHaveLength(1);
    expect(await db.select().from(idempotencyRecordsTable).where(eq(idempotencyRecordsTable.key, key))).toHaveLength(1);
    await assertCapacity(trip.id);
  });
  it("A10: response socket lost after commit; same key returns the original result", async () => {
    const trip = await start(), r = await create(), key = randomUUID();
    const outer = express();
    let dropped = false;
    outer.use((req, res, next) => {
      const end = res.end;
      res.end = function (...args: Parameters<typeof res.end>) {
        if (req.originalUrl === `/api/requests/${r.id}/accept` && !dropped) {
          dropped = true;
          res.socket?.destroy(); // operation has committed before res.json/res.end
          return res;
        }
        return end.apply(res, args);
      } as typeof res.end;
      next();
    });
    outer.use(app);
    const server = outer.listen(0, "127.0.0.1");
    try {
      let lost = false;
      try {
        await request(server).post(`/api/requests/${r.id}/accept`).set("Host", "app.test")
          .set("Origin", origin).set("Cookie", drivers[0]!).set("Idempotency-Key", key).send({});
      } catch { lost = true; }
      expect(lost).toBe(true);
      expect(dropped).toBe(true);
      expect(await events(r.id, "accepted")).toHaveLength(1);
      const retry = await post(`/requests/${r.id}/accept`, drivers[0], key).send({});
      expect(retry.status).toBe(200); expect(retry.body.replayed).toBe(true);
      const [saved] = await db.select().from(idempotencyRecordsTable).where(eq(idempotencyRecordsTable.key, key));
      const { replayed, ...originalBody } = retry.body;
      expect(originalBody).toEqual(saved!.responseBody);
      expect(retry.headers["idempotency-replayed"]).toBe("true");
      expect(await events(r.id, "accepted")).toHaveLength(1);
      await assertCapacity(trip.id);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it("A11: same key and different content is rejected, with user/operation scopes independent", async () => {
    const key = randomUUID(), first = await post("/requests", passengers[0], key).send(input());
    expect(first.status).toBe(200);
    const conflict = await post("/requests", passengers[0], key).send(input(1));
    expect(conflict.status).toBe(409); expect(conflict.body.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await post("/requests", passengers[1], key).send(input())).status).toBe(200);
    expect((await post(`/requests/${first.body.id}/cancel`, passengers[0], key)).status).toBe(200);
  });
  for (const final of ["cancelled", "completed"] as const) {
    it(`old accept replay cannot restore ${final} to accepted`, async () => {
      const trip = await start(), r = await create(), key = randomUUID();
      const original = await post(`/requests/${r.id}/accept`, drivers[0], key).send({});
      expect(original.status).toBe(200);
      if (final === "completed") {
        expect((await post(`/requests/${r.id}/board`, passengers[0])).status).toBe(200);
        expect((await post(`/requests/${r.id}/complete`, drivers[0])).status).toBe(200);
      } else expect((await post(`/requests/${r.id}/cancel`, passengers[0])).status).toBe(200);
      const retry = await post(`/requests/${r.id}/accept`, drivers[0], key).send({});
      expect(retry.body).toMatchObject({ status: "accepted", replayed: true });
      expect((await get(`/requests/${r.id}`, admin)).body.request.status).toBe(final);
      expect(await events(r.id, "accepted")).toHaveLength(1);
      await assertCapacity(trip.id);
    });
  }
});

describe("capacity, timeouts, presence and trip lifecycle (A13–A18)", () => {
  it("A13: owner-only boarding, repeated confirmations, driver-only completion and cancellation free once", async () => {
    const trip = await start(), r = await create();
    await post(`/requests/${r.id}/accept`, drivers[0]);
    expect((await post(`/requests/${r.id}/board`, drivers[0])).status).toBe(403);
    expect((await post(`/ride-requests/${r.id}/board`, drivers[0])).status).toBe(403);
    expect((await post(`/requests/${r.id}/board`, passengers[1])).status).toBe(404);
    // No location/proximity or boarding code is provided.
    const results = await Promise.all([1, 2].map(() => post(`/ride-requests/${r.id}/board`, passengers[0])));
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await events(r.id, "boarded")).toHaveLength(1);
    expect((await assertCapacity(trip.id)).boardedSeats).toBe(1);
    expect((await post(`/requests/${r.id}/cancel`, passengers[0])).status).toBe(409);
    expect((await post(`/requests/${r.id}/complete`, drivers[1])).status).toBe(404);
    expect((await post(`/requests/${r.id}/complete`, passengers[0])).status).toBe(403);
    for (let i = 0; i < 2; i++) expect((await post(`/requests/${r.id}/complete`, drivers[0])).status).toBe(200);
    expect(await events(r.id, "completed")).toHaveLength(1);
    expect((await assertCapacity(trip.id)).boardedSeats).toBe(0);
    const b = await create(1);
    await post(`/requests/${b.id}/accept`, drivers[0]);
    expect((await post(`/requests/${b.id}/cancel`, drivers[1]).send({ reason: "سبب" })).status).toBe(404);
    expect((await post(`/requests/${b.id}/cancel`, drivers[0])).status).toBe(400);
    expect((await post(`/requests/${b.id}/cancel`, drivers[0]).send({ reason: "تعذر الالتقاء" })).status).toBe(200);
    expect((await post(`/requests/${b.id}/cancel`, passengers[1])).status).toBe(200);
    expect((await assertCapacity(trip.id)).reservedSeats).toBe(0);
    expect(await events(b.id, "cancelled")).toHaveLength(1);
  });
  it("A14: pending expires at exactly five minutes; accepted at ten minutes releases reservation only", async () => {
    const trip = await start(0, 2), r = await create();
    tick(5 * 60_000);
    const late = await post(`/requests/${r.id}/accept`, drivers[0]);
    expect(late.body.code).toBe("REQUEST_EXPIRED");
    expect((await assertCapacity(trip.id)).externalOccupied).toBe(2);
    await post("/driver/trip/heartbeat", drivers[0]).send({ tripId: trip.id });
    const a = await create(), b = await create(1);
    await post(`/requests/${a.id}/accept`, drivers[0]);
    await post(`/requests/${b.id}/accept`, drivers[0]);
    await post(`/requests/${b.id}/board`, passengers[1]);
    tick(10 * 60_000);
    await Promise.all([expireStaleRequests(), expireStaleRequests()]);
    const t = await assertCapacity(trip.id);
    expect(t.reservedSeats).toBe(0); expect(t.boardedSeats).toBe(1); expect(t.externalOccupied).toBe(2);
    expect(await events(a.id, "expired")).toHaveLength(1);
    expect(await events(b.id, "expired")).toHaveLength(0);
    expect((await get(`/requests/${a.id}`, admin)).body.request.terminalReason).toBe("accepted_timeout");
    expect((await get(`/requests/${r.id}`, admin)).body.request.terminalReason).toBe("pending_timeout");
  });
  it("A15: stale trip refuses new acceptance but preserves accepted bookings and location time", async () => {
    const trip = await start(), a = await create(), b = await create(1);
    await post(`/requests/${a.id}/accept`, drivers[0]);
    tick(20_001);
    expect((await post(`/requests/${b.id}/accept`, drivers[0])).body.code).toBe("TRIP_STALE");
    expect((await get("/driver/state", drivers[0]!)).body.trip.isStale).toBe(true);
    expect((await get(`/requests/${a.id}`, admin)).body.request.status).toBe("accepted");
    const heartbeat = await post("/driver/trip/heartbeat", drivers[0]).send({ tripId: trip.id });
    expect(heartbeat.body.lastLocationAt).toBe(trip.lastLocationAt);
    expect(heartbeat.body.lastSeenAt).not.toBe(trip.lastSeenAt);
    expect((await post(`/requests/${b.id}/accept`, drivers[0])).status).toBe(200);
    await assertCapacity(trip.id);
  });
  it("location sequencing rejects backward progress and ignores late samples, with independent heartbeat", async () => {
    const trip = await start();
    const sample = { sequence: 2, source: "manual", lat: 34.7, lng: 36.7, progressSequence: 3 };
    const update = await post("/driver/trip/heartbeat", drivers[0]).send({ tripId: trip.id, location: sample });
    expect(update.status).toBe(200);
    tick(1000);
    const late = await post("/driver/trip/heartbeat", drivers[0]).send({ tripId: trip.id, location: { ...sample, sequence: 1, progressSequence: 1, lat: 0 } });
    expect(late.body).toMatchObject({ lat: 34.7, progressSequence: 3, locationSequence: 2, lastLocationAt: update.body.lastLocationAt });
    expect(late.body.lastSeenAt).not.toBe(update.body.lastSeenAt);
    expect((await post("/driver/trip/heartbeat", drivers[0]).send({ tripId: trip.id, location: { ...sample, sequence: 3, progressSequence: 2 } })).body.code).toBe("PROGRESS_REGRESSION");
    expect((await post("/driver/trip/heartbeat", drivers[1]).send({ tripId: trip.id })).status).toBe(404);
  });
  it("A16: direction/behind checks repeat on acceptance; passing pickup warns without fake boarding", async () => {
    const trip = await start(), a = await create(0, 1);
    await post(`/requests/${a.id}/accept`, drivers[0]);
    for (let i = 0; i < 2; i++) expect((await post(`/admin/trips/${trip.id}/advance`, admin)).status).toBe(200);
    const state = await get("/driver/requests", drivers[0]!);
    expect(state.body.mine[0]).toMatchObject({ id: a.id, status: "accepted", pickupPassed: true });
    expect(await events(a.id, "boarded")).toHaveLength(0);
    const b = await create(1, 1);
    expect((await post(`/requests/${b.id}/accept`, drivers[0])).body.code).toBe("PICKUP_PASSED");
    await post("/driver/trip", drivers[1]).send({ directionId: otherDirection });
    expect((await post(`/requests/${b.id}/accept`, drivers[1])).body.code).toBe("INVALID_DIRECTION");
    await assertCapacity(trip.id);
  });
  it("A17: occupancy is capacity-bounded and versioned, including concurrent stale edits", async () => {
    const trip = await start(), a = await create();
    await post(`/requests/${a.id}/accept`, drivers[0]);
    const state = (await get("/driver/state", drivers[0]!)).body.trip;
    const update = { tripId: trip.id, expectedVersion: state.version, externalOccupied: 6 };
    expect((await patch("/driver/trip/external-occupancy", drivers[0]!).send(update)).body.code).toBe("NO_CAPACITY");
    expect((await patch("/driver/trip/external-occupancy", drivers[0]!).send({ ...update, externalOccupied: -1 })).status).toBe(400);
    expect((await patch("/driver/trip/external-occupancy", drivers[0]!).send({ ...update, expectedVersion: 1, externalOccupied: 1 })).body.code).toBe("VERSION_CONFLICT");
    const pair = await Promise.all([2, 3].map((n) => patch("/driver/trip/external-occupancy", drivers[0]!).send({ ...update, externalOccupied: n })));
    expect(pair.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(pair.find((x) => x.status === 409)!.body.code).toBe("VERSION_CONFLICT");
    const t = await assertCapacity(trip.id);
    expect([2, 3]).toContain(t.externalOccupied);
    // Capacity snapshot is not changed by subsequent vehicle edits.
    await db.update(vehiclesTable).set({ capacity: 7 }).where(eq(vehiclesTable.id, trip.vehicleId));
    expect((await get("/driver/state", drivers[0]!)).body.trip.capacity).toBe(6);
    await db.update(vehiclesTable).set({ capacity: 6 }).where(eq(vehiclesTable.id, trip.vehicleId));
  });
  it("A18: boarded prevents end; completion then end cancels accepted, leaves pending available", async () => {
    const trip = await start(), a = await create(), b = await create(1), c = await create(2);
    await post(`/requests/${a.id}/accept`, drivers[0]);
    await post(`/requests/${b.id}/accept`, drivers[0]);
    await post(`/requests/${a.id}/board`, passengers[0]);
    expect((await post("/driver/trip/end", drivers[0])).body.code).toBe("BOARDED_REQUESTS_EXIST");
    await assertCapacity(trip.id);
    await post(`/requests/${a.id}/complete`, drivers[0]);
    expect((await post("/driver/trip/end", drivers[0])).status).toBe(200);
    expect((await get(`/requests/${b.id}`, admin)).body.request).toMatchObject({ status: "cancelled", terminalReason: "trip_ended" });
    expect((await get(`/requests/${c.id}`, admin)).body.request.status).toBe("pending");
    await start(1);
    expect((await post(`/requests/${c.id}/accept`, drivers[1])).status).toBe(200);
    await assertCapacity(trip.id);
  });
});

describe("demo protection and administration (A23)", () => {
  it("requires role AND demo mode for reset/step, preserves non-demo rows and attempt history", async () => {
    const trip = await start(), r = await create(), before = await db.select().from(usersTable);
    const [plain] = await db.insert(rideRequestsTable).values({ ...input(), passengerId: before.find((u) => u.key === "passenger-2")!.id,
      clientRequestId: randomUUID(), isDemoData: false, expiresAt: new Date(instant + 300_000) }).returning();
    expect((await post("/admin/reset", drivers[0])).status).toBe(403);
    expect((await post(`/admin/trips/${trip.id}/advance`, drivers[0])).status).toBe(403);
    expect((await post("/driver/trip/advance", drivers[0])).status).toBe(403);
    // Keep admin authorized via password-style fixture so the mode guard itself is reached.
    await pool.query("UPDATE sessions SET auth_method='password'");
    process.env.DEMO_MODE = "false";
    expect((await post("/admin/reset", admin)).status).toBe(403);
    expect((await post(`/admin/trips/${trip.id}/advance`, admin)).status).toBe(403);
    process.env.DEMO_MODE = "true";
    const key = randomUUID();
    expect((await post("/admin/reset", admin, key)).status).toBe(200);
    expect(await db.select().from(rideRequestsTable)).toEqual([plain]);
    expect(await db.select().from(tripsTable)).toHaveLength(0);
    expect(await db.select().from(usersTable)).toEqual(before);
    const newer = await create();
    expect((await post("/admin/reset", admin, key)).body.replayed).toBe(true);
    expect((await get(`/requests/${newer.id}`, admin)).body.request.status).toBe("pending");
    expect(await db.select().from(idempotencyRecordsTable).where(eq(idempotencyRecordsTable.key, key))).toHaveLength(1);
    await db.delete(rideRequestsTable).where(eq(rideRequestsTable.id, plain!.id)); // isolated test fixture cleanup
  });
  it("reset is atomic when a non-demo request refers to a demo trip", async () => {
    const trip = await start(), r = await create();
    await post(`/requests/${r.id}/accept`, drivers[0]);
    await db.update(rideRequestsTable).set({ isDemoData: false }).where(eq(rideRequestsTable.id, r.id));
    expect((await post("/admin/reset", admin)).status).toBe(409);
    expect((await get(`/requests/${r.id}`, admin)).body.request.status).toBe("accepted");
    expect(await events(r.id, "accepted")).toHaveLength(1);
    await assertCapacity(trip.id);
    await db.update(rideRequestsTable).set({ isDemoData: true }).where(eq(rideRequestsTable.id, r.id));
  });
  it("admin sees details/events, bounded filtered lists and database-computed totals", async () => {
    await start();
    const a = await create(), b = await create(1);
    await post(`/requests/${a.id}/accept`, drivers[0]);
    const detail = await get(`/requests/${a.id}`, admin);
    expect(detail.body.events.map((e: { toStatus: string }) => e.toStatus)).toEqual(["pending", "accepted"]);
    expect((await get("/admin/requests?status=accepted&limit=1", admin)).body.map((r: { id: number }) => r.id)).toEqual([a.id]);
    expect((await get("/admin/requests?limit=201", admin)).status).toBe(400);
    const s = (await get("/admin/summary", admin)).body;
    expect(s).toMatchObject({ pendingRequests: 1, acceptedRequests: 1, freeSeats: 5, activeTrips: 1 });
    expect((await get("/admin/requests?status=pending", admin)).body[0].id).toBe(b.id);
  });
});
