import { haversineMeters } from "./domain";

export interface MatchStop {
  id: number;
  seq: number;
  lat: number;
  lng: number;
}
export interface MatchDirection<S extends MatchStop = MatchStop> {
  id: number;
  stops: S[];
}
export type MatchInput =
  | { mode: "manual"; pickupStopId: number; dropoffStopId: number }
  | { mode: "coordinates"; originLat: number; originLng: number; destinationLat: number; destinationLng: number };

/** 600 m is a demo threshold for EACH endpoint, not walking/navigation advice. */
export function matchPairs<S extends MatchStop>(
  directions: MatchDirection<S>[], input: MatchInput, maxDistanceMeters = 600,
) {
  if (!Number.isFinite(maxDistanceMeters) || maxDistanceMeters <= 0) throw new Error("Invalid matching distance");
  const pairs: {
    directionId: number; pickup: S; dropoff: S;
    pickupDistance: number | null; dropoffDistance: number | null; score: number;
  }[] = [];
  for (const direction of directions) {
    for (const pickup of direction.stops) {
      for (const dropoff of direction.stops) {
        if (pickup.seq >= dropoff.seq) continue;
        if (input.mode === "manual") {
          if (pickup.id === input.pickupStopId && dropoff.id === input.dropoffStopId) {
            pairs.push({ directionId: direction.id, pickup, dropoff, pickupDistance: null, dropoffDistance: null, score: 0 });
          }
          continue;
        }
        const pickupDistance = haversineMeters(input.originLat, input.originLng, pickup.lat, pickup.lng);
        const dropoffDistance = haversineMeters(input.destinationLat, input.destinationLng, dropoff.lat, dropoff.lng);
        // Test full precision, never round before deciding the threshold.
        // Sub-nanometre slack handles floating-point error at the inclusive edge.
        const limit = maxDistanceMeters + 1e-9;
        if (pickupDistance > limit || dropoffDistance > limit) continue;
        pairs.push({ directionId: direction.id, pickup, dropoff, pickupDistance, dropoffDistance, score: pickupDistance + dropoffDistance });
      }
    }
  }
  // Tuple of persistent numeric identifiers is the stable pair identifier.
  return pairs.sort((a, b) => a.score - b.score || a.directionId - b.directionId ||
    a.pickup.id - b.pickup.id || a.dropoff.id - b.dropoff.id).slice(0, 3);
}

export function matchingDistanceLimit(): number {
  const value = Number(process.env.MATCH_MAX_DISTANCE_METERS ?? "600");
  if (!Number.isFinite(value) || value <= 0) throw new Error("MATCH_MAX_DISTANCE_METERS must be positive");
  return value;
}
