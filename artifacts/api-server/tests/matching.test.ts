import { describe, expect, it } from "vitest";
import { matchPairs, matchingDistanceLimit, type MatchDirection } from "../src/lib/matching";

const stop = (id: number, seq: number, lat = 0, lng = 0) => ({ id, seq, lat, lng });
const coordinateInput = { mode: "coordinates" as const, originLat: 0, originLng: 0, destinationLat: 0, destinationLng: 0.01 };
const directions: MatchDirection[] = [
  { id: 1, stops: [stop(1, 1), stop(2, 2, 0, 0.01), stop(3, 3, 0, 0.02)] },
  { id: 2, stops: [stop(4, 1, 0.001, 0.02), stop(5, 2, 0.001, 0.01), stop(6, 3, 0.001, 0)] },
];

describe("A01–A03 direction matching", () => {
  it("accepts only pickup before dropoff within the same independent direction", () => {
    const matches = matchPairs(directions, coordinateInput);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ directionId: 1, pickup: { id: 1 }, dropoff: { id: 2 } });
  });
  it("matches the return path using its own points, never a reversed sequence", () => {
    const matches = matchPairs(directions, { ...coordinateInput, originLng: 0.02, destinationLng: 0 });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ directionId: 2, pickup: { id: 4 }, dropoff: { id: 6 } });
    expect(matchPairs(directions, { mode: "manual", pickupStopId: 6, dropoffStopId: 4 })).toEqual([]);
  });
  it("manual selection needs no coordinates, checks order and rejects mixed directions/same point", () => {
    expect(matchPairs(directions, { mode: "manual", pickupStopId: 1, dropoffStopId: 3 })).toHaveLength(1);
    expect(matchPairs(directions, { mode: "manual", pickupStopId: 1, dropoffStopId: 4 })).toEqual([]);
    expect(matchPairs(directions, { mode: "manual", pickupStopId: 1, dropoffStopId: 1 })).toEqual([]);
    const [manual] = matchPairs(directions, { mode: "manual", pickupStopId: 1, dropoffStopId: 3 }, 1);
    expect(manual!.pickupDistance).toBeNull();
  });
  it("returns no suggestion for an outside-line destination", () => {
    expect(matchPairs(directions, { ...coordinateInput, destinationLat: 1 })).toEqual([]);
  });
  it("applies the inclusive 600 m limit independently to BOTH endpoints without rounding", () => {
    const latitudeAt = (meters: number) => meters / 6371000 * 180 / Math.PI;
    const pair = [{ id: 1, stops: [stop(1, 1), stop(2, 2, 0, 0.02)] }];
    const base = { ...coordinateInput, destinationLng: 0.02 };
    expect(matchPairs(pair, { ...base, originLat: latitudeAt(599.99) })).toHaveLength(1);
    expect(matchPairs(pair, { ...base, originLat: latitudeAt(600) })).toHaveLength(1);
    expect(matchPairs(pair, { ...base, originLat: latitudeAt(600.01) })).toHaveLength(0);
    expect(matchPairs(pair, { ...base, destinationLat: latitudeAt(600.01) })).toHaveLength(0);
    expect(matchPairs(pair, { ...base, originLat: latitudeAt(600.01) }, 601)).toHaveLength(1);
  });
  it("ranks all pairs globally by summed distances and returns only the best three", () => {
    const dense = [{ id: 1, stops: [
      stop(1, 1, 0, 0.001), stop(2, 2, 0, 0.002), stop(3, 3, 0, 0.003),
      stop(4, 4, 0, 0.004), stop(5, 5, 0, 0.005),
    ] }];
    const matches = matchPairs(dense, { ...coordinateInput, destinationLng: 0.005 });
    expect(matches).toHaveLength(3);
    expect(matches.map((p) => [p.pickup.id, p.dropoff.id])).toEqual([[1, 5], [1, 4], [2, 5]]);
    expect(matches.map((p) => p.score)).toEqual(matches.map((p) => p.score).sort((a, b) => a - b));
  });
  it("uses stable direction/pickup/dropoff identifiers when scores tie, regardless of input order", () => {
    const tied = [
      { id: 7, stops: [stop(4, 1), stop(5, 2), stop(6, 3)] },
      { id: 2, stops: [stop(3, 3), stop(1, 1), stop(2, 2)] },
    ];
    const input = { ...coordinateInput, destinationLng: 0 };
    const ids = (ds: typeof tied) => matchPairs(ds, input).map((p) => [p.directionId, p.pickup.id, p.dropoff.id]);
    expect(ids(tied)).toEqual([[2, 1, 2], [2, 1, 3], [2, 2, 3]]);
    expect(ids([...tied].reverse())).toEqual(ids(tied));
  });
  it("reads a configurable positive threshold and rejects bad configuration explicitly", () => {
    const old = process.env.MATCH_MAX_DISTANCE_METERS;
    try {
      delete process.env.MATCH_MAX_DISTANCE_METERS;
      expect(matchingDistanceLimit()).toBe(600);
      process.env.MATCH_MAX_DISTANCE_METERS = "800";
      expect(matchingDistanceLimit()).toBe(800);
      process.env.MATCH_MAX_DISTANCE_METERS = "invalid";
      expect(() => matchingDistanceLimit()).toThrow();
    } finally {
      if (old == null) delete process.env.MATCH_MAX_DISTANCE_METERS;
      else process.env.MATCH_MAX_DISTANCE_METERS = old;
    }
  });
});
