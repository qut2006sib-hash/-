import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, routesTable, tripsTable } from "@workspace/db";
import { GetRouteResponse, ListLiveTripsResponse, SuggestRouteBody, SuggestRouteResponse } from "@workspace/api-zod";
import { haversineMeters, loadRefs, serializeStop, serializeTrip, shortName, stopIndex, seatsFree, tripStale, expireStaleRequests } from "../lib/domain";
import { matchPairs, matchingDistanceLimit, type MatchInput } from "../lib/matching";
import { requireRole } from "../lib/session";
import { badRequest } from "../lib/http";

const router: IRouter = Router();
export const OUTSIDE_LINE = "الوجهة خارج نطاق الخط التجريبي";
export const NO_SERVICE = "الخط مناسب، ولا يوجد سرفيس متاح الآن";

router.get("/route", requireRole(), async (_req, res) => {
  const [route] = await db.select().from(routesTable).limit(1);
  if (!route) throw new Error("Demo route is not seeded");
  const refs = await loadRefs();
  const directions = [...refs.directions.values()].filter((d) => d.enabled && d.routeId === route.id).sort((a, b) => a.id - b.id);
  const ids = new Set(directions.map((d) => d.id));
  res.json(GetRouteResponse.parse({
    id: route.id, name: route.name, isDemoData: route.isDemoData,
    stops: [...refs.stops.values()].filter((s) => s.enabled && ids.has(s.directionId))
      .sort((a, b) => a.directionId - b.directionId || a.seq - b.seq).map(serializeStop),
    directions: directions.map((d) => ({
      id: d.id, code: d.code, name: d.name, fromName: d.fromName, toName: d.toName,
      geometry: d.geometry, stopIds: (refs.travelOrder.get(d.id) ?? []).map((s) => s.id),
    })),
  }));
});

router.get("/trips/live", requireRole(), async (_req, res) => {
  await expireStaleRequests();
  const refs = await loadRefs();
  const trips = await db.select().from(tripsTable).where(eq(tripsTable.status, "active"));
  res.json(ListLiveTripsResponse.parse(trips.filter((t) => {
    const v = refs.vehicles.get(t.vehicleId);
    return v?.enabled && refs.users.get(v.driverId)?.enabled && refs.directions.get(t.directionId)?.enabled;
  }).map((t) => serializeTrip(t, refs))));
});

router.post("/route/suggest", requireRole(), async (req, res) => {
  await expireStaleRequests();
  const body = SuggestRouteBody.parse(req.body);
  let input: MatchInput;
  if (body.mode === "manual") {
    if (body.pickupStopId == null || body.dropoffStopId == null ||
        [body.originLat, body.originLng, body.destinationLat, body.destinationLng].some((v) => v != null)) {
      throw badRequest("اختر نقطتي الصعود والنزول يدويًا دون إحداثيات");
    }
    input = { mode: "manual", pickupStopId: body.pickupStopId, dropoffStopId: body.dropoffStopId };
  } else {
    if (body.originLat == null || body.originLng == null || body.destinationLat == null || body.destinationLng == null ||
        body.pickupStopId != null || body.dropoffStopId != null) throw badRequest("يلزم موقع البداية والوجهة");
    input = { mode: "coordinates", originLat: body.originLat, originLng: body.originLng,
      destinationLat: body.destinationLat, destinationLng: body.destinationLng };
  }
  const refs = await loadRefs();
  const directions = [...refs.directions.values()].filter((d) => d.enabled);
  const pairs = matchPairs(directions.map((d) => ({ id: d.id, stops: refs.travelOrder.get(d.id) ?? [] })), input, matchingDistanceLimit());
  const trips = await db.select().from(tripsTable).where(eq(tripsTable.status, "active"));
  const suggestions = pairs.map((pair) => {
    const pickupIdx = stopIndex(refs, pair.directionId, pair.pickup.id);
    const availableTrips = trips.filter((t) => {
      const vehicle = refs.vehicles.get(t.vehicleId);
      const currentIndex = stopIndex(refs, pair.directionId, t.currentStopId);
      return t.directionId === pair.directionId && currentIndex >= 0 && currentIndex <= pickupIdx &&
        vehicle?.enabled && refs.users.get(vehicle.driverId)?.enabled && seatsFree(t) > 0 && !tripStale(t);
    }).map((t) => {
      const vehicle = refs.vehicles.get(t.vehicleId)!;
      return {
        tripId: t.id, plate: vehicle.plate, driverName: shortName(refs.users.get(vehicle.driverId)!.name),
        seatsFree: seatsFree(t),
        stopsAway: pickupIdx - stopIndex(refs, pair.directionId, t.currentStopId),
        distanceMeters: Math.round(haversineMeters(t.lat, t.lng, pair.pickup.lat, pair.pickup.lng)),
      };
    }).sort((a, b) => a.distanceMeters - b.distanceMeters || a.tripId - b.tripId);
    return {
      directionId: pair.directionId, directionName: refs.directions.get(pair.directionId)!.name,
      pickupStop: serializeStop(pair.pickup), dropoffStop: serializeStop(pair.dropoff),
      walkToPickupMeters: pair.pickupDistance == null ? null : Math.round(pair.pickupDistance),
      walkFromDropoffMeters: pair.dropoffDistance == null ? null : Math.round(pair.dropoffDistance),
      stopsCount: pair.dropoff.seq - pair.pickup.seq, availableTrips,
    };
  });
  res.json(SuggestRouteResponse.parse({
    suggestions,
    note: !suggestions.length ? OUTSIDE_LINE : suggestions.every((s) => !s.availableTrips.length) ? NO_SERVICE :
      "مسافة مباشرة تقريبية؛ المسار والنقاط تجريبية وغير معتمدة للملاحة",
  }));
});
export default router;
