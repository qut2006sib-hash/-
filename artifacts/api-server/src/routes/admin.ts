import { Router, type IRouter } from "express";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db, requestEventsTable, rideRequestsTable, routeStopsTable, tripsTable, usersTable } from "@workspace/db";
import { alias } from "drizzle-orm/pg-core";
import {
  GetAdminSummaryResponse,
  ListAdminEventsResponse,
  ListAdminRequestsQueryParams,
  ListAdminRequestsResponse,
  ListAdminVehiclesResponse,
  ResetDemoResponse,
  PrepareDemoResponse,
} from "@workspace/api-zod";
import {
  ACTIVE_STATUSES,
  expireStaleRequests,
  loadRefs,
  serializeRequests,
  serializeTrip,
  serializeVehicle,
  shortName,
  type RequestStatus,
  seatsFree,
} from "../lib/domain";
import { resetDynamicData, prepareDemoScenario } from "../lib/seed";
import { currentUser, requireRole } from "../lib/session";
import { HttpError } from "../lib/http";
import { operation } from "../lib/operations";
import { lockTrip } from "../lib/ride-service";
import { now } from "../lib/clock";
import { GetRideRequestParams } from "@workspace/api-zod";
import { z } from "zod";

const router: IRouter = Router();
router.use("/admin", requireRole("admin"));

router.get("/admin/summary", async (_req, res) => {
  await expireStaleRequests();
  const refs = await loadRefs();
  const trips = await db.select().from(tripsTable).where(eq(tripsTable.status, "active"));
  const counts = await db
    .select({ status: rideRequestsTable.status, n: sql<number>`count(*)::int` })
    .from(rideRequestsTable)
    .groupBy(rideRequestsTable.status);
  const pendingByDirection = await db
    .select({ directionId: rideRequestsTable.directionId, n: sql<number>`count(*)::int` })
    .from(rideRequestsTable)
    .where(eq(rideRequestsTable.status, "pending"))
    .groupBy(rideRequestsTable.directionId);
  const count = (s: RequestStatus) => counts.find((c) => c.status === s)?.n ?? 0;
  const freeOf = seatsFree;

  res.json(
    GetAdminSummaryResponse.parse({
      activeTrips: trips.length,
      totalVehicles: refs.vehicles.size,
      pendingRequests: count("pending"),
      acceptedRequests: count("accepted"),
      boardedRequests: count("boarded"),
      completedRequests: count("completed"),
      cancelledRequests: count("cancelled"),
      expiredRequests: count("expired"),
      freeSeats: trips.reduce((sum, t) => sum + freeOf(t), 0),
      directions: [...refs.directions.values()].map((d) => {
        const dt = trips.filter((t) => t.directionId === d.id);
        return {
          directionId: d.id,
          directionName: d.name,
          activeTrips: dt.length,
          pendingRequests: pendingByDirection.find((p) => p.directionId === d.id)?.n ?? 0,
          freeSeats: dt.reduce((sum, t) => sum + freeOf(t), 0),
        };
      }),
    }),
  );
});

router.get("/admin/vehicles", async (_req, res) => {
  const refs = await loadRefs();
  const trips = await db.select().from(tripsTable).where(eq(tripsTable.status, "active"));
  const activeByTrip = await db
    .select({ tripId: rideRequestsTable.tripId, n: sql<number>`count(*)::int` })
    .from(rideRequestsTable)
    .where(inArray(rideRequestsTable.status, ACTIVE_STATUSES))
    .groupBy(rideRequestsTable.tripId);
  const vehicles = [...refs.vehicles.values()].sort((a, b) => a.id - b.id);
  res.json(
    ListAdminVehiclesResponse.parse(
      vehicles.map((v) => {
        const trip = trips.find((t) => t.vehicleId === v.id);
        return {
          vehicle: serializeVehicle(v, refs),
          ...(trip ? { trip: serializeTrip(trip, refs) } : {}),
          activeRequests: trip ? (activeByTrip.find((a) => a.tripId === trip.id)?.n ?? 0) : 0,
        };
      }),
    ),
  );
});

router.get("/admin/requests", async (req, res) => {
  const user = currentUser(req);
  const { status } = ListAdminRequestsQueryParams.parse(req.query);
  const { limit, offset } = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  }).parse(req.query);
  await expireStaleRequests();
  const rows = await db
    .select()
    .from(rideRequestsTable)
    .where(status ? eq(rideRequestsTable.status, status) : undefined)
    .orderBy(desc(rideRequestsTable.createdAt), desc(rideRequestsTable.id))
    .limit(limit).offset(offset);
  res.json(ListAdminRequestsResponse.parse(await serializeRequests(rows, user)));
});

router.get("/admin/events", async (_req, res) => {
  await expireStaleRequests();
  const pickup = alias(routeStopsTable, "pickup");
  const dropoff = alias(routeStopsTable, "dropoff");
  const rows = await db
    .select({
      event: requestEventsTable,
      passengerName: usersTable.name,
      pickupStopName: pickup.name,
      dropoffStopName: dropoff.name,
    })
    .from(requestEventsTable)
    .innerJoin(rideRequestsTable, eq(rideRequestsTable.id, requestEventsTable.requestId))
    .innerJoin(usersTable, eq(usersTable.id, rideRequestsTable.passengerId))
    .innerJoin(pickup, eq(pickup.id, rideRequestsTable.pickupStopId))
    .innerJoin(dropoff, eq(dropoff.id, rideRequestsTable.dropoffStopId))
    .orderBy(desc(requestEventsTable.createdAt), desc(requestEventsTable.id))
    .limit(50);
  res.json(
    ListAdminEventsResponse.parse(
      rows.map((r) => ({
        id: r.event.id,
        requestId: r.event.requestId,
        fromStatus: r.event.fromStatus,
        toStatus: r.event.toStatus,
        actorRole: r.event.actorRole,
        actorName: shortName(r.event.actorName),
        note: r.event.note,
        createdAt: r.event.createdAt,
        passengerName: shortName(r.passengerName),
        pickupStopName: r.pickupStopName,
        dropoffStopName: r.dropoffStopName,
      })),
    ),
  );
});

router.post("/admin/reset", async (req, res) => {
  if (process.env.DEMO_MODE !== "true") throw new HttpError(403, "إعادة التهيئة متاحة في وضع العرض فقط");
  await operation(req, res, "demo.reset", async (tx) => {
    await resetDynamicData(tx);
    return ResetDemoResponse.parse({ ok: true, message: "تمت إعادة تهيئة بيانات العرض" });
  });
});

router.post("/admin/prepare", async (req, res) => {
  if (process.env.DEMO_MODE !== "true") throw new HttpError(403, "تحضير السيناريو متاح في وضع العرض فقط");
  await operation(req, res, "demo.prepare", async (tx, op) => {
    await prepareDemoScenario(tx, op);
    return PrepareDemoResponse.parse({ ok: true, message: "تم تحضير سيناريو العرض" });
  });
});

router.post("/admin/trips/:id/advance", async (req, res) => {
  if (process.env.DEMO_MODE !== "true") throw new HttpError(403, "المحاكاة متاحة في وضع العرض فقط");
  const { id } = GetRideRequestParams.parse(req.params);
  await operation(req, res, "demo.step", async (tx) => {
    const trip = await lockTrip(tx, id);
    if (!trip.isDemoData || trip.status !== "active") throw new HttpError(409, "ليست رحلة عرض فعّالة");
    const refs = await loadRefs();
    const next = refs.travelOrder.get(trip.directionId)?.find((s) => s.seq === trip.progressSequence + 1);
    if (!next) throw new HttpError(409, "وصلت المركبة لآخر الخط");
    const [row] = await tx.update(tripsTable).set({
      currentStopId: next.id, progressSequence: next.seq, lat: next.lat, lng: next.lng,
      locationSource: "simulation", locationSequence: trip.locationSequence + 1,
      lastLocationAt: now(), version: trip.version + 1,
    }).where(eq(tripsTable.id, id)).returning();
    // A demo location does not pretend the driver is still sending heartbeats.
    return serializeTrip(row!, refs);
  });
});

export default router;
