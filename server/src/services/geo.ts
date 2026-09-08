// Small geodetic helpers for placing authored pins. Distance measurement lives in
// locationSanityCheck.ts (`haversineMeters`); this is the inverse direction — given a point,
// where is one N metres away.

import { EARTH_RADIUS_M } from './locationSanityCheck.js';

// Derived from the same sphere `haversineMeters` measures on, rather than a rounded constant.
// Otherwise placing a pin 2km away and then measuring the distance back disagree by ~0.1%,
// which is exactly the sort of drift that shows up as a pin in the wrong place on a field test.
const METERS_PER_DEGREE_LAT = (Math.PI * EARTH_RADIUS_M) / 180;

/**
 * Moves a point east by `meters`, using the local flat-earth approximation. Accurate to well
 * under a metre at the scale a quest trail spans (hundreds of metres), which is far inside the
 * SR-GEO-04 effective radius — the exact geodesic isn't worth the complexity here.
 */
export function offsetPointEast(
  lat: number,
  lng: number,
  meters: number,
): { lat: number; lng: number } {
  const metersPerDegreeLng = METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180);
  if (Math.abs(metersPerDegreeLng) < 1e-6) {
    // At the poles a degree of longitude collapses to nothing and this offset is meaningless.
    throw new RangeError(`Cannot offset east from latitude ${lat} — too close to a pole.`);
  }
  return { lat, lng: lng + meters / metersPerDegreeLng };
}
