import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { rideRequestsTable, tripsTable, usersTable, vehiclesTable, type DbRideRequest, type DbUser } from "@workspace/db";
import {
  ACCEPTED_TTL_MS, PENDING_TTL_MS, expireInTx, loadRefs, recordEvent, seatsFree,
  serializeRequest, tripStale, type Refs, type Tx,
} from "./domain";
import { badRequest, conflict, notFound } from "./http";
import { now } from "./clock";

export async function lockTrip(tx: Tx, id: number, driverId?: number) {
  const [trip] = await tx.select().from(tripsTable).where(eq(tripsTable.id, id)).for("update");
  if (!trip || (driverId != null && trip.driverId !== driverId)) throw notFound("الرحلة غير موجودة");
  return trip;
}

export async function driverTrip(tx: Tx, driverId: number) {
  const [trip] = await tx.select().from(tripsTable).where(and(
    eq(tripsTable.driverId, driverId), eq(tripsTable.status, "active"),
  )).for("update");
  if (!trip) throw conflict("فعّل رحلتك أولًا");
  return trip;
}

export async function requestResult(tx: Tx, row: DbRideRequest, user: DbUser, refs?: Refs) {
  const trip = row.tripId == null ? undefined : (await tx.select().from(tripsTable).where(eq(tripsTable.id, row.tripId)))[0];
  return serializeRequest(row, refs ?? await loadRefs(), new Map(trip ? [[trip.id, trip]] : []), user);
}

export async function createRequest(tx: Tx, user: DbUser, input: {
  directionId: number; pickupStopId: number; dropoffStopId: number;
}, operationId: string) {
  await expireInTx(tx);
  const refs = await loadRefs();
  const pickup = refs.stops.get(input.pickupStopId), dropoff = refs.stops.get(input.dropoffStopId);
  if (!refs.directions.get(input.directionId)?.enabled || !pickup?.enabled || !dropoff?.enabled ||
      pickup.directionId !== input.directionId || dropoff.directionId !== input.directionId || pickup.seq >= dropoff.seq) {
    throw badRequest("نقطتا الصعود والنزول غير صالحتين لهذا الاتجاه", "INVALID_DIRECTION");
  }
  const active = await tx.select().from(rideRequestsTable).where(and(
    eq(rideRequestsTable.passengerId, user.id), inArray(rideRequestsTable.status, ["pending", "accepted", "boarded"]),
  )).limit(1);
  if (active.length) throw conflict("عندك طلب نشط بالفعل", "ACTIVE_REQUEST_EXISTS");
  const [row] = await tx.insert(rideRequestsTable).values({
    ...input, clientRequestId: randomUUID(), passengerId: user.id, createdAt: now(),
    expiresAt: new Date(now().getTime() + PENDING_TTL_MS), isDemoData: process.env.DEMO_MODE === "true",
  }).returning();
  await recordEvent(tx, { requestId: row!.id, fromStatus: null, toStatus: "pending",
    actorRole: user.role, actorName: user.name, operationId });
  return requestResult(tx, row!, user, refs);
}

export async function transitionRequest(
  tx: Tx, user: DbUser, id: number, action: "accept" | "cancel" | "board" | "complete",
  operationId: string, reason?: string,
) {
  // All related timeouts are processed while holding the domain lock.
  await expireInTx(tx);
  const [snapshot] = await tx.select().from(rideRequestsTable).where(eq(rideRequestsTable.id, id));
  if (!snapshot) throw notFound("الطلب غير موجود");
  const trip = action === "accept" ? await driverTrip(tx, user.id)
    : snapshot.tripId == null ? undefined : await lockTrip(tx, snapshot.tripId);
  const [r] = await tx.select().from(rideRequestsTable).where(eq(rideRequestsTable.id, id)).for("update");
  if (!r) throw notFound("الطلب غير موجود");
  const refs = await loadRefs();
  const assigned = user.role === "driver" && trip?.driverId === user.id;
  const owner = user.role === "passenger" && r.passengerId === user.id;
  let status: DbRideRequest["status"], reservedDelta = 0, boardedDelta = 0;
  let patch: Partial<DbRideRequest> = {};
  if (action === "accept") {
    if (user.role !== "driver" || !trip) throw notFound("الرحلة غير موجودة");
    if (r.status === "accepted" || r.status === "boarded") throw conflict("قُبل الطلب مسبقًا", "REQUEST_TAKEN");
    if (r.status === "expired" || r.expiresAt.getTime() <= now().getTime()) throw conflict("انتهت مهلة الطلب", "REQUEST_EXPIRED");
    if (r.status !== "pending") throw conflict("لم يعد الطلب متاحًا");
    if (trip.status !== "active" || !refs.vehicles.get(trip.vehicleId)?.enabled || !refs.users.get(user.id)?.enabled) throw conflict("الرحلة غير متاحة");
    if (tripStale(trip)) throw conflict("انقطع حضور السائق؛ حدّث الاتصال أولًا", "TRIP_STALE");
    if (!refs.directions.get(trip.directionId)?.enabled || trip.directionId !== r.directionId) throw conflict("اتجاه مختلف", "INVALID_DIRECTION");
    if (refs.stops.get(r.pickupStopId)!.seq < trip.progressSequence) throw conflict("تجاوزت نقطة الصعود", "PICKUP_PASSED");
    if (seatsFree(trip) < 1) throw conflict("لا توجد مقاعد متاحة", "NO_CAPACITY");
    status = "accepted"; reservedDelta = 1;
    patch = { tripId: trip.id, acceptedAt: now(), expiresAt: new Date(now().getTime() + ACCEPTED_TTL_MS) };
  } else if (action === "cancel") {
    if (!owner && !assigned) throw notFound("الطلب غير موجود");
    if (assigned && !reason?.trim()) throw badRequest("اكتب سبب الإلغاء");
    if (r.status === "cancelled") return requestResult(tx, r, user, refs);
    if (r.status !== "pending" && r.status !== "accepted") throw conflict("الإلغاء متاح قبل الصعود فقط");
    if (assigned && r.status !== "accepted") throw conflict("يمكن إلغاء الطلب المقبول في رحلتك فقط");
    status = "cancelled"; reservedDelta = r.status === "accepted" ? -1 : 0;
    patch = { cancelledAt: now(), cancelReason: reason?.trim() || "ألغاه الراكب", terminalReason: assigned ? "driver_cancelled" : "passenger_cancelled" };
  } else if (action === "board") {
    if (!owner) throw notFound("تأكيد الصعود لصاحب الطلب فقط");
    if (r.status === "boarded") return requestResult(tx, r, user, refs);
    if (r.status !== "accepted") throw conflict("الطلب غير مقبول أو انتهت مهلته");
    status = "boarded"; reservedDelta = -1; boardedDelta = 1;
    patch = { boardedAt: now() };
  } else {
    if (!assigned) throw notFound("الإتمام للسائق المخصص فقط");
    if (r.status === "completed") return requestResult(tx, r, user, refs);
    if (r.status !== "boarded") throw conflict("يجب أن يؤكد الراكب الصعود أولًا");
    status = "completed"; boardedDelta = -1;
    patch = { completedAt: now(), terminalReason: "completed" };
  }
  if (trip && (reservedDelta || boardedDelta)) {
    await tx.update(tripsTable).set({
      reservedSeats: trip.reservedSeats + reservedDelta, boardedSeats: trip.boardedSeats + boardedDelta,
      seatsTaken: trip.reservedSeats + reservedDelta + trip.boardedSeats + boardedDelta,
      version: trip.version + 1,
    }).where(eq(tripsTable.id, trip.id));
  }
  const [row] = await tx.update(rideRequestsTable).set({ ...patch, status, version: r.version + 1 })
    .where(eq(rideRequestsTable.id, id)).returning();
  await recordEvent(tx, { requestId: id, fromStatus: r.status, toStatus: status, actorRole: user.role,
    actorName: user.name, note: action === "board" ? "أكد الراكب الصعود" : reason, operationId });
  return requestResult(tx, row!, user, refs);
}

export async function endTrip(tx: Tx, user: DbUser, operationId: string) {
  await expireInTx(tx);
  const trip = await driverTrip(tx, user.id);
  const open = await tx.select().from(rideRequestsTable).where(and(eq(rideRequestsTable.tripId, trip.id),
    inArray(rideRequestsTable.status, ["accepted", "boarded"]))).orderBy(asc(rideRequestsTable.id)).for("update");
  if (open.some((r) => r.status === "boarded")) throw conflict("أتمم نزول الركاب الصاعدين قبل إنهاء الرحلة", "BOARDED_REQUESTS_EXIST");
  for (const r of open) {
    await tx.update(rideRequestsTable).set({ status: "cancelled", cancelledAt: now(),
      cancelReason: "أنهى السائق الرحلة قبل الصعود", terminalReason: "trip_ended", version: r.version + 1,
    }).where(eq(rideRequestsTable.id, r.id));
    await recordEvent(tx, { requestId: r.id, fromStatus: "accepted", toStatus: "cancelled",
      actorRole: "driver", actorName: user.name, note: "trip_ended", operationId });
  }
  const [row] = await tx.update(tripsTable).set({
    status: "ended", endedAt: now(), reservedSeats: 0, seatsTaken: 0, version: trip.version + 1,
  }).where(eq(tripsTable.id, trip.id)).returning();
  return row!;
}
