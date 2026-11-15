import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db, routesTable, routeDirectionsTable, routeStopsTable, usersTable,
  vehiclesTable, tripsTable, rideRequestsTable, requestEventsTable,
} from "@workspace/db";
import { DEMO_DIRECTIONS } from "./demo-line";
import { PENDING_TTL_MS, type Tx } from "./domain";
import { now } from "./clock";
import { conflict } from "./http";
import { lockDomain } from "./operations";

/** Explicit initial data only. Never invoked at startup or by account setup. */
export async function ensureBaseData(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(735303)`);
    if ((await tx.select().from(routesTable).limit(1)).length) return;
    const users = await tx.select().from(usersTable);
    const driverIds = [1, 2, 3].map((n) => users.find((u) => u.key === `driver-${n}`)?.id);
    if (driverIds.some((id) => !id)) throw new Error("شغّل accounts:setup أولًا");
    const [route] = await tx.insert(routesTable).values({ name: "خط الوعر ↔ وسط حمص", isDemoData: true }).returning();
    for (const direction of DEMO_DIRECTIONS) {
      const [d] = await tx.insert(routeDirectionsTable).values({ ...direction, routeId: route!.id }).returning();
      await tx.insert(routeStopsTable).values(direction.geometry.map((p, i) => ({
        ...p, directionId: d!.id, seq: i + 1, name: `نقطة تجريبية ${i + 1}`,
      })));
    }
    await tx.insert(vehiclesTable).values(driverIds.map((driverId, i) => ({
      driverId: driverId!, plate: `DEMO-00${i + 1}`, label: `سرفيس تجريبي ${i + 1}`,
      description: "مركبة عرض تجريبية — ستة مقاعد", capacity: 6, enabled: true,
    })));
  });
}

async function guardDemo(tx: Tx) {
  if (process.env.DEMO_MODE !== "true") throw conflict("أدوات العرض متاحة في وضع العرض فقط");
  await lockDomain(tx);
}

/** Explicit destructive reset to EMPTY. Does not touch accounts/sessions/reference data. */
export async function resetDynamicData(transaction?: Tx): Promise<void> {
  const reset = async (tx: Tx) => {
    await guardDemo(tx);
    // Non-demo requests attached to demo trips must survive. Refuse the entire
    // reset rather than partially deleting or cascading across this boundary.
    const unsafe = await tx.execute(sql`SELECT 1 FROM ride_requests r JOIN trips t ON t.id=r.trip_id
      WHERE t.is_demo_data=true AND r.is_demo_data=false LIMIT 1`);
    if (unsafe.rows.length) throw conflict("رحلة تجريبية مرتبطة ببيانات غير تجريبية؛ لم تتغير البيانات");
    const requests = await tx.select({ id: rideRequestsTable.id }).from(rideRequestsTable).where(eq(rideRequestsTable.isDemoData, true));
    if (requests.length) {
      const ids = requests.map((r) => r.id);
      await tx.delete(requestEventsTable).where(inArray(requestEventsTable.requestId, ids));
      await tx.delete(rideRequestsTable).where(inArray(rideRequestsTable.id, ids));
    }
    // Recalculate preserved trips if they contained explicitly demo requests.
    await tx.execute(sql`UPDATE trips t SET
      reserved_seats=(SELECT count(*) FROM ride_requests r WHERE r.trip_id=t.id AND r.status='accepted'),
      boarded_seats=(SELECT count(*) FROM ride_requests r WHERE r.trip_id=t.id AND r.status='boarded'),
      seats_taken=(SELECT count(*) FROM ride_requests r WHERE r.trip_id=t.id AND r.status IN ('accepted','boarded')),
      version=version+1 WHERE t.is_demo_data=false`);
    await tx.delete(tripsTable).where(eq(tripsTable.isDemoData, true));
  };
  if (transaction) await reset(transaction);
  else await db.transaction(reset);
}

/** Separate, non-destructive scenario preparation. Refuses existing dynamic data. */
export async function prepareDemoScenario(transaction?: Tx, operationId?: string): Promise<void> {
  const prepare = async (tx: Tx) => {
    await guardDemo(tx);
    const trips = await tx.select().from(tripsTable).limit(1);
    const requests = await tx.select().from(rideRequestsTable).limit(1);
    if (trips.length || requests.length) throw conflict("البيانات موجودة؛ أعد تهيئة العرض أولًا", "DEMO_NOT_EMPTY");
    const users = await tx.select().from(usersTable);
    const vehicles = await tx.select().from(vehiclesTable);
    const directions = await tx.select().from(routeDirectionsTable).where(eq(routeDirectionsTable.enabled, true));
    const stops = await tx.select().from(routeStopsTable).where(eq(routeStopsTable.enabled, true));
    const center = directions.find((d) => d.code === "to_center");
    const waer = directions.find((d) => d.code === "to_waer");
    if (!center || !waer) throw conflict("يلزم إعداد بيانات الخط أولًا");
    const stopAt = (directionId: number, seq: number) => {
      const stop = stops.find((s) => s.directionId === directionId && s.seq === seq);
      if (!stop) throw conflict("بيانات النقاط التجريبية غير مكتملة");
      return stop;
    };
    for (const [key, direction] of [["driver-2", center], ["driver-3", waer]] as const) {
      const user = users.find((u) => u.key === key && u.enabled);
      const vehicle = vehicles.find((v) => v.driverId === user?.id && v.enabled);
      if (!vehicle) throw conflict("حسابات العرض ومركباتها غير جاهزة");
      const s = stopAt(direction.id, 1);
      await tx.insert(tripsTable).values({
        vehicleId: vehicle.id, directionId: direction.id, currentStopId: s.id,
        driverId: vehicle.driverId, capacitySnapshot: vehicle.capacity, isDemoData: true,
        lat: s.lat, lng: s.lng, seatsTaken: 0, startedAt: now(), lastLocationAt: now(), lastSeenAt: now(),
      });
    }
    const passenger = users.find((u) => u.key === "passenger-3" && u.enabled);
    if (!passenger) throw conflict("حساب الراكب التجريبي غير جاهز");
    const [waiting] = await tx.insert(rideRequestsTable).values({
      clientRequestId: `demo-scenario-${now().getTime()}`, passengerId: passenger.id,
      directionId: center.id, pickupStopId: stopAt(center.id, 3).id, dropoffStopId: stopAt(center.id, 6).id,
      status: "pending", isDemoData: true, createdAt: now(), expiresAt: new Date(now().getTime() + PENDING_TTL_MS),
    }).returning();
    await tx.insert(requestEventsTable).values({
      requestId: waiting!.id, fromStatus: null, toStatus: "pending", actorRole: "passenger",
      actorName: passenger.name, note: "سيناريو عرض محضّر صراحةً", createdAt: now(), operationId,
    });
  };
  if (transaction) await prepare(transaction);
  else await db.transaction(prepare);
}
