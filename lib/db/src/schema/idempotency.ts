import { integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./servicna";

export const idempotencyRecordsTable = pgTable("idempotency_records", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  operation: text("operation").notNull(),
  key: text("key").notNull(),
  payloadHash: text("payload_hash").notNull(),
  responseStatus: integer("response_status").notNull(),
  responseBody: jsonb("response_body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("idempotency_scope_uq").on(t.userId, t.operation, t.key)]);
