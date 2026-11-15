/** Generated illustrative data, not surveyed stops or navigation geometry. */
const center = [
  [34.7432, 36.6605], [34.7401, 36.6688], [34.7368, 36.6779],
  [34.7322, 36.6884], [34.7309, 36.7126], [34.7334, 36.7172],
];
const waer = [
  [34.7345, 36.7170], [34.7320, 36.7115], [34.7334, 36.6888],
  [34.7380, 36.6784], [34.7415, 36.6695], [34.7444, 36.6610],
];
export const DEMO_DIRECTIONS = [
  { code: "to_center" as const, name: "باتجاه وسط حمص", fromName: "الوعر", toName: "وسط حمص", points: center },
  { code: "to_waer" as const, name: "باتجاه الوعر", fromName: "وسط حمص", toName: "الوعر", points: waer },
].map(({ points, ...direction }) => ({
  ...direction,
  geometry: points.map(([lat, lng]) => ({ lat: lat!, lng: lng! })),
}));
