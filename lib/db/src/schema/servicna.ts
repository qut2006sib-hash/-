import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  role: text("role").$type<"passenger" | "driver" | "admin">().notNull(),
  loginName: text("login_name").notNull().unique(),
  passwordHash: text("password_hash"),
  enabled: boolean("enabled").notNull().default(false),
  description: text("description").notNull().default(""),
});

export const sessionsTable = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  authMethod: text("auth_method").$type<"password" | "demo">().notNull().default("password"),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expiry_idx").on(t.expiresAt)]);

export const loginAttemptsTable = pgTable("login_attempts", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
});

export const appSettingsTable = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const routesTable = pgTable("routes", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  isDemoData: boolean("is_demo_data").notNull().default(true),
});

// Archived stops remain addressable by historical requests.
export const routeStopsTable = pgTable(
  "route_stops",
  {
    id: serial("id").primaryKey(),
    directionId: integer("direction_id")
      .notNull()
      .references(() => routeDirectionsTable.id),
    enabled: boolean("enabled").notNull().default(true),
    seq: integer("seq").notNull(),
    name: text("name").notNull(),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
  },
  (t) => [uniqueIndex("route_stops_direction_seq_uq").on(t.directionId, t.seq).where(sql`enabled = true`)],
);

// Each direction has independent geometry and ascending travel sequences.
export const routeDirectionsTable = pgTable("route_directions", {
  id: serial("id").primaryKey(),
  routeId: integer("route_id")
    .notNull()
    .references(() => routesTable.id),
  code: text("code").$type<"to_center" | "to_waer">().notNull().unique(),
  name: text("name").notNull(),
  fromName: text("from_name").notNull(),
  toName: text("to_name").notNull(),
  geometry: jsonb("geometry").$type<{ lat: number; lng: number }[]>().notNull(),
  enabled: boolean("enabled").notNull().default(true),
});

export const vehiclesTable = pgTable("vehicles", {
  id: serial("id").primaryKey(),
  plate: text("plate").notNull().unique(),
  label: text("label").notNull(),
  description: text("description").notNull().default("مركبة عرض تجريبية"),
  enabled: boolean("enabled").notNull().default(true),
  capacity: integer("capacity").notNull(),
  driverId: integer("driver_id")
    .notNull()
    .unique()
    .references(() => usersTable.id),
});

export const tripsTable = pgTable(
  "trips",
  {
    id: serial("id").primaryKey(),
    vehicleId: integer("vehicle_id")
      .notNull()
      .references(() => vehiclesTable.id),
    directionId: integer("direction_id")
      .notNull()
      .references(() => routeDirectionsTable.id),
    status: text("status").$type<"active" | "ended">().notNull().default("active"),
    seatsTaken: integer("seats_taken").notNull().default(0),
    driverId: integer("driver_id").notNull().references(() => usersTable.id),
    capacitySnapshot: integer("capacity_snapshot").notNull(),
    externalOccupied: integer("external_occupied").notNull().default(0),
    reservedSeats: integer("reserved_seats").notNull().default(0),
    boardedSeats: integer("boarded_seats").notNull().default(0),
    progressSequence: integer("progress_sequence").notNull().default(1),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    locationSource: text("location_source").$type<"gps" | "simulation" | "manual">().notNull().default("simulation"),
    locationSequence: integer("location_sequence").notNull().default(0),
    version: integer("version").notNull().default(1),
    isDemoData: boolean("is_demo_data").notNull().default(false),
    currentStopId: integer("current_stop_id")
      .notNull()
      .references(() => routeStopsTable.id),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    isSimulated: boolean("is_simulated").notNull().default(true),
    lastLocationAt: timestamp("last_location_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    // One active trip per vehicle.
    uniqueIndex("trips_one_active_per_vehicle")
      .on(t.vehicleId)
      .where(sql`status = 'active'`),
    uniqueIndex("trips_one_active_per_driver").on(t.driverId).where(sql`status = 'active'`),
  ],
);

export const rideRequestsTable = pgTable(
  "ride_requests",
  {
    id: serial("id").primaryKey(),
    clientRequestId: text("client_request_id").notNull().unique(),
    passengerId: integer("passenger_id")
      .notNull()
      .references(() => usersTable.id),
    directionId: integer("direction_id")
      .notNull()
      .references(() => routeDirectionsTable.id),
    pickupStopId: integer("pickup_stop_id")
      .notNull()
      .references(() => routeStopsTable.id),
    dropoffStopId: integer("dropoff_stop_id")
      .notNull()
      .references(() => routeStopsTable.id),
    seats: integer("seats").notNull().default(1),
    status: text("status")
      .$type<"pending" | "accepted" | "boarded" | "completed" | "cancelled" | "expired">()
      .notNull()
      .default("pending"),
    tripId: integer("trip_id").references(() => tripsTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    boardedAt: timestamp("boarded_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    cancelReason: text("cancel_reason"),
    terminalReason: text("terminal_reason"),
    version: integer("version").notNull().default(1),
    isDemoData: boolean("is_demo_data").notNull().default(false),
  },
  (t) => [
    // One active request per passenger, enforced by the database.
    uniqueIndex("ride_requests_one_active_per_passenger")
      .on(t.passengerId)
      .where(sql`status in ('pending','accepted','boarded')`),
    index("ride_requests_status_idx").on(t.status),
  ],
);

export const requestEventsTable = pgTable(
  "request_events",
  {
    id: serial("id").primaryKey(),
    requestId: integer("request_id")
      .notNull()
      .references(() => rideRequestsTable.id, { onDelete: "cascade" }),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    actorRole: text("actor_role").notNull(),
    actorName: text("actor_name").notNull(),
    note: text("note"),
    operationId: text("operation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("request_events_request_idx").on(t.requestId)],
);

export type DbUser = typeof usersTable.$inferSelect;
export type DbStop = typeof routeStopsTable.$inferSelect;
export type DbDirection = typeof routeDirectionsTable.$inferSelect;
export type DbVehicle = typeof vehiclesTable.$inferSelect;
export type DbTrip = typeof tripsTable.$inferSelect;
export type DbRideRequest = typeof rideRequestsTable.$inferSelect;
export type DbRequestEvent = typeof requestEventsTable.$inferSelect;
