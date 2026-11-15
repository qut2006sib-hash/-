export interface Clock { now(): Date }

const systemClock: Clock = { now: () => new Date() };
let clock: Clock = systemClock;

export const now = (): Date => clock.now();

/** Internal test seam only. There is deliberately no HTTP endpoint for this. */
export function setClockForTests(value: Clock): () => void {
  if (process.env.NODE_ENV !== "test") throw new Error("Clock injection is test-only");
  const previous = clock;
  clock = value;
  return () => { clock = previous; };
}
