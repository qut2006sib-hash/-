import { createHash, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, idempotencyRecordsTable, tripsTable, rideRequestsTable } from "@workspace/db";
import { currentUser } from "./session";
import { badRequest, conflict, HttpError } from "./http";
import { now } from "./clock";
import type { Tx } from "./domain";

/** Single lock order for the small demo dataset:
 * domain advisory lock → all trips (ascending id) → all requests (ascending id).
 * Deliberately serializes mutations across API processes, never an in-memory mutex.
 * Prelocking is important: expiration can touch a different trip before the
 * action's own trip. Every entrypoint takes the complete ordered lock set once.
 */
export async function lockDomain(tx: Tx) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(735303)`);
  await tx.select({ id: tripsTable.id }).from(tripsTable).orderBy(tripsTable.id).for("update");
  await tx.select({ id: rideRequestsTable.id }).from(rideRequestsTable).orderBy(rideRequestsTable.id).for("update");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Response and events are committed together. Errors use a savepoint so a failed
 * action is also repeatable without retaining partial business writes. */
export async function operation(
  req: Request, res: Response, name: string,
  execute: (tx: Tx, operationId: string) => Promise<unknown>,
) {
  const key = req.get("Idempotency-Key");
  if (!key || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw badRequest("يلزم مفتاح محاولة صالح", "IDEMPOTENCY_KEY_REQUIRED");
  const user = currentUser(req);
  const hash = createHash("sha256").update(canonical({ params: req.params, body: req.body ?? {} })).digest("hex");
  const result = await db.transaction(async (tx) => {
    await lockDomain(tx);
    const scope = and(eq(idempotencyRecordsTable.userId, user.id), eq(idempotencyRecordsTable.operation, name), eq(idempotencyRecordsTable.key, key));
    const [saved] = await tx.select().from(idempotencyRecordsTable).where(scope);
    if (saved) {
      if (saved.payloadHash !== hash) throw conflict("استُخدم مفتاح المحاولة بمحتوى مختلف", "IDEMPOTENCY_CONFLICT");
      return { status: saved.responseStatus, body: saved.responseBody, replayed: true };
    }
    let status = 200, body: unknown;
    await tx.execute(sql`SAVEPOINT business_action`);
    try {
      body = await execute(tx, randomUUID());
      await tx.execute(sql`RELEASE SAVEPOINT business_action`);
    } catch (err) {
      await tx.execute(sql`ROLLBACK TO SAVEPOINT business_action`);
      if (!(err instanceof HttpError)) throw err;
      status = err.status;
      body = { code: err.code, message: err.message };
    }
    // Persist exact JSON, including original state, not a pointer to mutable rows.
    body = JSON.parse(JSON.stringify(body));
    await tx.insert(idempotencyRecordsTable).values({
      userId: user.id, operation: name, key, payloadHash: hash,
      responseStatus: status, responseBody: body, createdAt: now(),
    });
    return { status, body, replayed: false };
  });
  res.set("Idempotency-Replayed", String(result.replayed));
  res.status(result.status).json({ ...(result.body as object), replayed: result.replayed });
}
