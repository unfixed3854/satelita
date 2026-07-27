// Day/night shading. The subsolar point comes from satellite.js's own
// Vallado sun model rather than a hand-rolled solar position formula —
// it is already a dependency, and its accuracy (0.01 degrees, valid
// 1950-2050) is far beyond what a shaded map needs.

import { gstime, jday, radiansToDegrees, sunPos } from "satellite.js";

export interface Subsolar {
  lat: number;
  lon: number;
}

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Below this declination the terminator curve's tan() blows up. Clamping
 * costs a few kilometres of accuracy for the two days a year either side
 * of an equinox, and avoids a divide-by-zero that would blank the layer. */
const MIN_DECLINATION_DEG = 0.1;

/** Normalises degrees into [-180, 180]. */
function wrapLongitude(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/** The point on Earth with the sun directly overhead: its latitude is the
 * solar declination, and its longitude is the sun's right ascension
 * measured against the Greenwich meridian's current sidereal angle. */
export function subsolarPoint(date: Date): Subsolar {
  const { rtasc, decl } = sunPos(jday(date));
  return {
    lat: radiansToDegrees(decl),
    lon: wrapLongitude(radiansToDegrees(rtasc - gstime(date))),
  };
}

/** Latitude at which the terminator crosses a given meridian.
 *
 * Solving cos(angular distance to the sun) = 0 for latitude gives
 * tan(lat) = -cos(hour angle) / tan(declination). Expressing the curve per
 * column of the map means polar day and polar night need no special case:
 * the curve simply runs off the top or bottom edge. */
export function terminatorLatitude(lonDeg: number, sub: Subsolar): number {
  let declination = sub.lat;
  if (Math.abs(declination) < MIN_DECLINATION_DEG) {
    declination = declination >= 0 ? MIN_DECLINATION_DEG : -MIN_DECLINATION_DEG;
  }
  const hourAngle = toRad(lonDeg - sub.lon);
  return radiansToDegrees(
    Math.atan(-Math.cos(hourAngle) / Math.tan(toRad(declination))),
  );
}

/** True when the sun is below the horizon — that is, when the point is
 * more than 90 degrees of arc away from the subsolar point. */
export function isNight(latDeg: number, lonDeg: number, sub: Subsolar): boolean {
  const cosDistance = Math.sin(toRad(latDeg)) * Math.sin(toRad(sub.lat)) +
    Math.cos(toRad(latDeg)) * Math.cos(toRad(sub.lat)) *
      Math.cos(toRad(lonDeg - sub.lon));
  return cosDistance < 0;
}
