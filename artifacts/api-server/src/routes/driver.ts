import { Router, type IRouter } from "express";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, rideRequestsTable, tripsTable, vehiclesTable } from "@workspace/db";
import {
  GetDriverRequestsResponse, GetDriverStateResponse, HeartbeatTripBody, StartTripBody, UpdateExternalOccupancyBody,
} from "@workspace/api-zod";
import { badRequest, conflict, HttpError } from "../lib/http";
import {
  expireStaleRequests, loadRefs, serializeRequests, serializeAvailableRequest,
  serializeTrip, serializeUser, serializeVehicle, tripStale, seatsFree, expireInTx,
} from "../lib/domain";
import { currentUser, requireRole } from "../lib/session";
import { now } from "../lib/clock";
import { lockDomain, operation } from "../lib/operations";
import { driverTrip, endTrip, lockTrip } from "../lib/ride-service";

const router: IRouter = Router();
router.use("/driver", requireRole("driver"));

router.get("/driver/state", async (req, res) => {
  const user = currentUser(req);
  await expireStaleRequests();
  const refs = await loadRefs();
  const vehicle = refs.vehicleByDriver.get(user.id);
  if (!vehicle) throw conflict("لا توجد مركبة مرتبطة بالسائق");
  const [trip] = await db.select().from(tripsTable).where(and(eq(tripsTable.driverId, user.id), eq(tripsTable.status, "active")));
  res.json(GetDriverStateResponse.parse({
    driver: serializeUser(user, refs), vehicle: serializeVehicle(vehicle, refs),
    ...(trip ? { trip: serializeTrip(trip, refs) } : {}),
  }));
});

router.post("/driver/trip", async (req, res) => {
  const user = currentUser(req), input = StartTripBody.parse(req.body);
  await operation(req, res, "trip.start", async (tx) => {
    const refs = await loadRefs(), vehicle = refs.vehicleByDriver.get(user.id);
    if (!vehicle?.enabled || (input.vehicleId != null && input.vehicleId !== vehicle.id)) throw conflict("المركبة غير مسموحة");
    const order = refs.travelOrder.get(input.directionId), first = order?.[0];
    if (!first) throw badRequest("الاتجاه غير معروف", "INVALID_DIRECTION");
    const externalOccupied = input.externalOccupied ?? 0;
    if (externalOccupied > vehicle.capacity) throw conflict("الإشغال يتجاوز السعة", "NO_CAPACITY");
    const active = await tx.select().from(tripsTable).where(and(eq(tripsTable.driverId, user.id), eq(tripsTable.status, "active")));
    if (active.length) throw conflict("عندك رحلة فعالة بالفعل");
    const [trip] = await tx.insert(tripsTable).values({
      vehicleId: vehicle.id, driverId: user.id, directionId: input.directionId, capacitySnapshot: vehicle.capacity,
      externalOccupied, currentStopId: first.id, progressSequence: first.seq, lat: first.lat, lng: first.lng,
      lastSeenAt: now(), lastLocationAt: now(), startedAt: now(), isDemoData: process.env.DEMO_MODE === "true",
    }).returning();
    return serializeTrip(trip!, refs);
  });
});

router.post("/driver/trip/heartbeat", async (req, res) => {
  const user = currentUser(req), input = HeartbeatTripBody.parse(req.body);
  const updated = await db.transaction(async (tx) => {
    await lockDomain(tx);
    const trip = await lockTrip(tx, input.tripId, user.id);
    if (trip.status !== "active") throw conflict("انتهت الرحلة");
    const sample = input.location;
    const patch: Partial<typeof trip> = { lastSeenAt: now() };
    if (sample && sample.sequence > trip.locationSequence) {
      // Simulation belongs exclusively to administration's demo step.
      if (sample.source === "simulation") throw new HttpError(403, "المحاكاة متاحة للإدارة فقط");
      if (sample.progressSequence < trip.progressSequence) throw conflict("تقدم الرحلة لا يرجع للخلف", "PROGRESS_REGRESSION");
      const refs = await loadRefs(), stop = refs.travelOrder.get(trip.directionId)?.find((s) => s.seq === sample.progressSequence);
      if (!stop) throw badRequest("نقطة تقدم غير صالحة");
      Object.assign(patch, {
        lat: sample.lat, lng: sample.lng, currentStopId: stop.id, progressSequence: sample.progressSequence,
        lastLocationAt: now(), locationSource: sample.source, locationSequence: sample.sequence,
      });
    }
    const [row] = await tx.update(tripsTable).set(patch).where(eq(tripsTable.id, trip.id)).returning();
    return row!;
  });
  res.json(serializeTrip(updated, await loadRefs()));
});

router.patch("/driver/trip/external-occupancy", async (req, res) => {
  const input = UpdateExternalOccupancyBody.parse(req.body);
  await expireStaleRequests();
  await operation(req, res, "trip.occupancy", async (tx) => {
    await expireInTx(tx);
    const trip = await lockTrip(tx, input.tripId, currentUser(req).id);
    if (trip.status !== "active") throw conflict("انتهت الرحلة");
    if (trip.version !== input.expectedVersion) throw conflict("تغيرت بيانات الرحلة؛ جلبنا الحالة الجديدة، حاول مجددًا", "VERSION_CONFLICT");
    if (input.externalOccupied + trip.reservedSeats + trip.boardedSeats > trip.capacitySnapshot) throw conflict("الإشغال يتجاوز المتاح", "NO_CAPACITY");
    const [row] = await tx.update(tripsTable).set({ externalOccupied: input.externalOccupied, version: trip.version + 1 })
      .where(eq(tripsTable.id, trip.id)).returning();
    return serializeTrip(row!, await loadRefs());
  });
});

// Explicitly deny the obsolete driver simulation endpoint.
router.post("/driver/trip/advance", async () => { throw new HttpError(403, "تحريك المركبة التجريبية للإدارة فقط"); });
router.post("/driver/trip/end", async (req, res) => {
  await expireStaleRequests();
  await operation(req, res, "trip.end", async (tx, op) => serializeTrip(await endTrip(tx, currentUser(req), op), await loadRefs()));
});

router.get("/driver/requests", async (req, res) => {
  const user = currentUser(req);
  await expireStaleRequests();
  const refs = await loadRefs();
  const [trip] = await db.select().from(tripsTable).where(and(eq(tripsTable.driverId, user.id), eq(tripsTable.status, "active")));
  if (!trip) { res.json({ tripId: null, available: [], mine: [] }); return; }
  const pending = await db.select().from(rideRequestsTable).where(and(eq(rideRequestsTable.status, "pending"),
    eq(rideRequestsTable.directionId, trip.directionId))).orderBy(asc(rideRequestsTable.createdAt), asc(rideRequestsTable.id));
  const available = tripStale(trip) || seatsFree(trip) < 1 || !refs.vehicles.get(trip.vehicleId)?.enabled ? [] : pending
    .filter((r) => refs.stops.get(r.pickupStopId)!.seq >= trip.progressSequence)
    .sort((a, b) => refs.stops.get(a.pickupStopId)!.seq - refs.stops.get(b.pickupStopId)!.seq);
  const mine = await db.select().from(rideRequestsTable).where(and(eq(rideRequestsTable.tripId, trip.id),
    inArray(rideRequestsTable.status, ["accepted", "boarded"]))).orderBy(asc(rideRequestsTable.acceptedAt));
  res.json(GetDriverRequestsResponse.parse({ tripId: trip.id,
    available: available.map((r) => serializeAvailableRequest(r, refs)), mine: await serializeRequests(mine, user, refs) }));
});
export default router;
