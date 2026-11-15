import { Router, type IRouter } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db, requestEventsTable, rideRequestsTable, tripsTable } from "@workspace/db";
import {
  CancelRideRequestBody, CreateRideRequestBody, GetActiveRequestResponse,
  GetRideRequestParams, GetRideRequestResponse, ListPassengerHistoryQueryParams, ListPassengerHistoryResponse,
} from "@workspace/api-zod";
import { notFound } from "../lib/http";
import { ACTIVE_STATUSES, expireStaleRequests, serializeEvent, serializeRequests } from "../lib/domain";
import { currentUser, requireRole } from "../lib/session";
import { operation } from "../lib/operations";
import { createRequest, transitionRequest } from "../lib/ride-service";

const router: IRouter = Router();
async function eventsFor(id: number) {
  return (await db.select().from(requestEventsTable).where(eq(requestEventsTable.requestId, id))
    .orderBy(asc(requestEventsTable.createdAt), asc(requestEventsTable.id))).map(serializeEvent);
}

router.get("/passenger/active-request", requireRole("passenger"), async (req, res) => {
  const user = currentUser(req);
  await expireStaleRequests();
  const [active] = await db.select().from(rideRequestsTable).where(and(
    eq(rideRequestsTable.passengerId, user.id), inArray(rideRequestsTable.status, ACTIVE_STATUSES),
  )).limit(1);
  res.json(GetActiveRequestResponse.parse(active
    ? { hasActive: true, request: (await serializeRequests([active], user))[0], events: await eventsFor(active.id) }
    : { hasActive: false, events: [] }));
});

router.get("/passenger/history", requireRole("passenger"), async (req, res) => {
  const user = currentUser(req);
  const { page = 1, pageSize = 10 } = ListPassengerHistoryQueryParams.parse(req.query);
  await expireStaleRequests();
  const rows = await db.select().from(rideRequestsTable).where(eq(rideRequestsTable.passengerId, user.id))
    .orderBy(desc(rideRequestsTable.createdAt), desc(rideRequestsTable.id)).limit(pageSize).offset((page - 1) * pageSize);
  const [count] = await db.select({ total: sql<number>`count(*)::int` }).from(rideRequestsTable).where(eq(rideRequestsTable.passengerId, user.id));
  res.json(ListPassengerHistoryResponse.parse({ items: await serializeRequests(rows, user),
    page, pageSize, total: count!.total, totalPages: Math.ceil(count!.total / pageSize) }));
});

router.post("/requests", requireRole("passenger"), async (req, res) => {
  const input = CreateRideRequestBody.parse(req.body);
  // Process timeouts separately so a rejected/replayed action cannot undo expiry.
  await expireStaleRequests();
  await operation(req, res, "request.create", (tx, id) => createRequest(tx, currentUser(req), {
    directionId: input.directionId, pickupStopId: input.pickupStopId, dropoffStopId: input.dropoffStopId,
  }, id));
});

router.get("/requests/:id", requireRole(), async (req, res) => {
  const user = currentUser(req), { id } = GetRideRequestParams.parse(req.params);
  await expireStaleRequests();
  const [row] = await db.select().from(rideRequestsTable).where(eq(rideRequestsTable.id, id));
  if (!row) throw notFound("الطلب غير موجود");
  const trip = row.tripId == null ? undefined : (await db.select().from(tripsTable).where(eq(tripsTable.id, row.tripId)))[0];
  if (!(user.role === "admin" || (user.role === "passenger" && row.passengerId === user.id) ||
      (user.role === "driver" && trip?.driverId === user.id))) throw notFound("الطلب غير موجود");
  res.json(GetRideRequestResponse.parse({ request: (await serializeRequests([row], user))[0], events: await eventsFor(id) }));
});

router.post("/requests/:id/cancel", requireRole("passenger", "driver"), async (req, res) => {
  const { id } = GetRideRequestParams.parse(req.params);
  const { reason } = CancelRideRequestBody.parse(req.body ?? {});
  await expireStaleRequests();
  await operation(req, res, "request.cancel", (tx, op) => transitionRequest(tx, currentUser(req), id, "cancel", op, reason));
});
router.post("/requests/:id/accept", requireRole("driver"), async (req, res) => {
  const { id } = GetRideRequestParams.parse(req.params);
  await expireStaleRequests();
  await operation(req, res, "request.accept", (tx, op) => transitionRequest(tx, currentUser(req), id, "accept", op));
});

// Both spellings enforce passenger ownership. No driver boarding route remains.
router.post(["/requests/:id/board", "/ride-requests/:id/board"], requireRole("passenger"), async (req, res) => {
  const { id } = GetRideRequestParams.parse(req.params);
  await expireStaleRequests();
  await operation(req, res, "request.board", (tx, op) => transitionRequest(tx, currentUser(req), id, "board", op));
});
router.post("/requests/:id/complete", requireRole("driver"), async (req, res) => {
  const { id } = GetRideRequestParams.parse(req.params);
  await expireStaleRequests();
  await operation(req, res, "request.complete", (tx, op) => transitionRequest(tx, currentUser(req), id, "complete", op));
});
export default router;
