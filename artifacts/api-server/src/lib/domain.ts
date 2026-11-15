import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import {
  db,
  requestEventsTable,
  rideRequestsTable,
  routeDirectionsTable,
  routeStopsTable,
  tripsTable,
  usersTable,
  vehiclesTable,
  type DbDirection,
  type DbRequestEvent,
  type DbRideRequest,
  type DbStop,
  type DbTrip,
  type DbUser,
  type DbVehicle,
} from "@workspace/db";
import { now } from "./clock";
import { lockDomain } from "./operations";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type RequestStatus = DbRideRequest["status"];

/** Pending requests expire if no driver accepts them within this window. */
export const PENDING_TTL_MS = 5 * 60 * 1000;
export const ACCEPTED_TTL_MS = 10 * 60 * 1000;
export const HEARTBEAT_TTL_MS = 20_000;
export const tripStale = (t: DbTrip) => now().getTime() - t.lastSeenAt.getTime() > HEARTBEAT_TTL_MS;
export const seatsFree = (t: DbTrip) => t.capacitySnapshot - t.externalOccupied - t.reservedSeats - t.boardedSeats;
export const ACTIVE_STATUSES: RequestStatus[] = ["pending", "accepted", "boarded"];

export const STATUS_LABELS: Record<RequestStatus, string> = {
  pending: "بانتظار القبول",
  accepted: "مقبول",
  boarded: "صعد الراكب",
  completed: "مكتمل",
  cancelled: "ملغى",
  expired: "منتهي المهلة",
};

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// Reference data (small, static tables) loaded per request
// ---------------------------------------------------------------------------

export interface Refs {
  stops: Map<number, DbStop>;
  directions: Map<number, DbDirection>;
  users: Map<number, DbUser>;
  vehicles: Map<number, DbVehicle>;
  vehicleByDriver: Map<number, DbVehicle>;
  /** Stops in travel order for each direction id. */
  travelOrder: Map<number, DbStop[]>;
}

export async function loadRefs(): Promise<Refs> {
  const [stops, directions, users, vehicles] = await Promise.all([
    db.select().from(routeStopsTable),
    db.select().from(routeDirectionsTable),
    db.select().from(usersTable),
    db.select().from(vehiclesTable),
  ]);
  const sorted = [...stops].sort((a, b) => a.seq - b.seq);
  const travelOrder = new Map<number, DbStop[]>();
  for (const d of directions) {
    travelOrder.set(d.id, d.enabled ? sorted.filter((s) => s.directionId === d.id && s.enabled) : []);
  }
  return {
    stops: new Map(stops.map((s) => [s.id, s])),
    directions: new Map(directions.map((d) => [d.id, d])),
    users: new Map(users.map((u) => [u.id, u])),
    vehicles: new Map(vehicles.map((v) => [v.id, v])),
    vehicleByDriver: new Map(vehicles.map((v) => [v.driverId, v])),
    travelOrder,
  };
}

/** Position of a stop along a direction (0-based), or -1 if unknown. */
export function stopIndex(refs: Refs, directionId: number, stopId: number): number {
  const order = refs.travelOrder.get(directionId) ?? [];
  return order.findIndex((s) => s.id === stopId);
}

/** Distance travelled along the line between two stops in a direction. */
export function alongRouteMeters(refs: Refs, directionId: number, fromStopId: number, toStopId: number): number {
  const order = refs.travelOrder.get(directionId) ?? [];
  const a = stopIndex(refs, directionId, fromStopId);
  const b = stopIndex(refs, directionId, toStopId);
  if (a < 0 || b < 0 || b < a) return 0;
  let total = 0;
  for (let i = a; i < b; i++) {
    total += haversineMeters(order[i]!.lat, order[i]!.lng, order[i + 1]!.lat, order[i + 1]!.lng);
  }
  return Math.round(total);
}

function must<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`Missing reference data: ${what}`);
  return v;
}

// ---------------------------------------------------------------------------
// Serializers (API shapes)
// ---------------------------------------------------------------------------

export function serializeStop(s: DbStop) {
  return { id: s.id, directionId: s.directionId, name: s.name, seq: s.seq, lat: s.lat, lng: s.lng };
}

export function serializeUser(u: DbUser, refs?: Refs) {
  return {
    id: u.id,
    name: shortName(u.name),
    role: u.role,
    vehicleId: refs?.vehicleByDriver.get(u.id)?.id ?? null,
  };
}

export function shortName(name: string): string {
  const [first, ...rest] = name.trim().split(/\s+/);
  return rest.length ? `${first} ${rest[0]!.slice(0, 1)}.` : first!;
}

/** Separate allowlisted shape: no account id, name, token, event, or phone. */
export function serializeAvailableRequest(r: DbRideRequest, refs: Refs) {
  return {
    id: r.id,
    pickupStop: serializeStop(must(refs.stops.get(r.pickupStopId), "pickup")),
    dropoffStop: serializeStop(must(refs.stops.get(r.dropoffStopId), "dropoff")),
    waitingSeconds: Math.max(0, Math.floor((now().getTime() - r.createdAt.getTime()) / 1000)),
  };
}

export function serializeVehicle(v: DbVehicle, refs: Refs) {
  return {
    id: v.id,
    plate: v.plate,
    label: v.description,
    capacity: v.capacity,
    driverId: v.driverId,
    driverName: shortName(must(refs.users.get(v.driverId), "driver").name),
  };
}

export function serializeTrip(t: DbTrip, refs: Refs) {
  const vehicle = must(refs.vehicles.get(t.vehicleId), "vehicle");
  const direction = must(refs.directions.get(t.directionId), "direction");
  const stop = must(refs.stops.get(t.currentStopId), "stop");
  return {
    id: t.id,
    vehicleId: vehicle.id,
    plate: vehicle.plate,
    driverName: shortName(must(refs.users.get(vehicle.driverId), "driver").name),
    directionId: direction.id,
    directionName: direction.name,
    status: t.status,
    capacity: t.capacitySnapshot,
    seatsTaken: t.externalOccupied + t.reservedSeats + t.boardedSeats,
    seatsFree: seatsFree(t),
    externalOccupancy: t.externalOccupied,
    reservedSeats: t.reservedSeats,
    boardedSeats: t.boardedSeats,
    progressSequence: t.progressSequence,
    lastSeenAt: t.lastSeenAt,
    isStale: tripStale(t),
    locationSource: t.locationSource,
    locationSequence: t.locationSequence,
    version: t.version,
    currentStopId: stop.id,
    currentStopName: stop.name,
    lat: t.lat,
    lng: t.lng,
    lastLocationAt: t.lastLocationAt,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    isSimulated: t.isSimulated,
  };
}

export interface Viewer {
  id: number;
  role: DbUser["role"];
}

export function serializeRequest(
  r: DbRideRequest,
  refs: Refs,
  trips: Map<number, DbTrip>,
  viewer: Viewer,
) {
  const passenger = must(refs.users.get(r.passengerId), "passenger");
  const direction = must(refs.directions.get(r.directionId), "direction");
  const pickup = must(refs.stops.get(r.pickupStopId), "pickup");
  const dropoff = must(refs.stops.get(r.dropoffStopId), "dropoff");
  const trip = r.tripId != null ? trips.get(r.tripId) : undefined;
  const vehicle = trip ? refs.vehicles.get(trip.vehicleId) : undefined;
  const driver = vehicle ? refs.users.get(vehicle.driverId) : undefined;

  // Personal data is only shown to the people who need it.
  const isAdmin = viewer.role === "admin";
  const isOwner = viewer.id === r.passengerId;
  const isAssignedDriver = driver?.id === viewer.id;
  const matched = r.status === "accepted" || r.status === "boarded";
  const showPassengerName = isAdmin || isOwner || (isAssignedDriver && r.status !== "pending");

  let stopsAway: number | null = null;
  if (trip && trip.status === "active" && r.status === "accepted") {
    const diff =
      stopIndex(refs, r.directionId, r.pickupStopId) -
      stopIndex(refs, r.directionId, trip.currentStopId);
    stopsAway = Math.max(0, diff);
  }

  return {
    id: r.id,
    clientRequestId: r.clientRequestId,
    status: r.status,
    passengerId: passenger.id,
    passengerName: showPassengerName ? shortName(passenger.name) : null,
    directionId: direction.id,
    directionName: direction.name,
    pickupStop: serializeStop(pickup),
    dropoffStop: serializeStop(dropoff),
    seats: r.seats,
    tripId: r.tripId,
    vehiclePlate: vehicle?.plate ?? null,
    vehicleLabel: vehicle?.description ?? null,
    driverName: driver ? shortName(driver.name) : null,
    tripCurrentStopName: trip ? (refs.stops.get(trip.currentStopId)?.name ?? null) : null,
    stopsAway,
    createdAt: r.createdAt,
    acceptedAt: r.acceptedAt,
    boardedAt: r.boardedAt,
    completedAt: r.completedAt,
    cancelledAt: r.cancelledAt,
    expiresAt: r.expiresAt,
    cancelReason: r.cancelReason,
    terminalReason: r.terminalReason,
    version: r.version,
    pickupPassed: r.status === "accepted" && !!trip && pickup.seq < trip.progressSequence,
  };
}

export function serializeEvent(e: DbRequestEvent) {
  return {
    id: e.id,
    requestId: e.requestId,
    fromStatus: e.fromStatus,
    toStatus: e.toStatus as RequestStatus,
    actorRole: e.actorRole,
    actorName: shortName(e.actorName),
    note: e.note,
    createdAt: e.createdAt,
  };
}

/** Load the trips referenced by a set of requests. */
export async function tripsFor(requests: DbRideRequest[]): Promise<Map<number, DbTrip>> {
  const ids = [...new Set(requests.map((r) => r.tripId).filter((x): x is number => x != null))];
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(tripsTable).where(inArray(tripsTable.id, ids));
  return new Map(rows.map((t) => [t.id, t]));
}

export async function serializeRequests(requests: DbRideRequest[], viewer: Viewer, refs?: Refs) {
  const r = refs ?? (await loadRefs());
  const trips = await tripsFor(requests);
  return requests.map((req) => serializeRequest(req, r, trips, viewer));
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

export async function recordEvent(
  tx: Tx,
  e: {
    requestId: number;
    fromStatus: RequestStatus | null;
    toStatus: RequestStatus;
    actorRole: "passenger" | "driver" | "admin" | "system";
    actorName: string;
    note?: string | null;
    operationId?: string | null;
  },
): Promise<void> {
  await tx.insert(requestEventsTable).values({ ...e, actorName: shortName(e.actorName), note: e.note ?? null, createdAt: now() });
}

/** Domain lock must already be held. Trip rows precede request rows everywhere. */
export async function expireInTx(tx: Tx): Promise<void> {
  const candidates = await tx.select().from(rideRequestsTable).where(and(
    inArray(rideRequestsTable.status, ["pending", "accepted"]), lte(rideRequestsTable.expiresAt, now()),
  )).orderBy(asc(rideRequestsTable.id));
  const tripIds = [...new Set(candidates.flatMap((r) => r.tripId == null ? [] : [r.tripId]))].sort((a, b) => a - b);
  for (const id of tripIds) await tx.select().from(tripsTable).where(eq(tripsTable.id, id)).for("update");
  for (const r of candidates) {
    await tx.select().from(rideRequestsTable).where(eq(rideRequestsTable.id, r.id)).for("update");
    if (r.status === "accepted" && r.tripId != null) {
      await tx.update(tripsTable).set({
        reservedSeats: sql`${tripsTable.reservedSeats} - 1`,
        seatsTaken: sql`${tripsTable.seatsTaken} - 1`, version: sql`${tripsTable.version} + 1`,
      }).where(eq(tripsTable.id, r.tripId));
    }
    const reason = r.status === "pending" ? "pending_timeout" : "accepted_timeout";
    await tx.update(rideRequestsTable).set({
      status: "expired", terminalReason: reason, version: r.version + 1,
    }).where(eq(rideRequestsTable.id, r.id));
    await recordEvent(tx, {
      requestId: r.id, fromStatus: r.status, toStatus: "expired", actorRole: "system",
      actorName: "النظام", note: reason, operationId: `expiry:${r.id}:${r.version}`,
    });
  }
}

export async function expireStaleRequests(): Promise<void> {
  await db.transaction(async (tx) => { await lockDomain(tx); await expireInTx(tx); });
}
