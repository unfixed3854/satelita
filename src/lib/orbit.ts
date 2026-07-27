// A narrow wrapper over satellite.js so nothing else in the app has to
// touch its API or its radians-everywhere convention. Every value crossing
// this boundary is in degrees, kilometres, or metres.

import {
  degreesLat,
  degreesLong,
  ecfToLookAngles,
  eciToEcf,
  eciToGeodetic,
  gstime,
  propagate,
  radiansToDegrees,
  type SatRec,
  twoline2satrec,
} from "satellite.js";

/** Mean Earth radius. Deliberately the spherical mean rather than either
 * ellipsoid radius satellite.js carries internally (6378.135 for SGP4's
 * WGS72, 6378.137 for WGS84 transforms): the footprint is a circle on a
 * sphere by construction, so the mean radius is the self-consistent
 * choice. The difference is under 0.1 degrees of footprint radius. */
const EARTH_RADIUS_KM = 6371;

export interface Observer {
  lat: number;
  lon: number;
  altM: number;
}

export interface Subpoint {
  lat: number;
  lon: number;
  altKm: number;
}

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface LookAngles {
  elevationDeg: number;
  azimuthDeg: number;
  rangeKm: number;
}

const toRad = (deg: number) => (deg * Math.PI) / 180;

function observerGeodetic(observer: Observer) {
  return {
    longitude: toRad(observer.lon),
    latitude: toRad(observer.lat),
    height: observer.altM / 1000,
  };
}

/** Returns null rather than throwing for element sets SGP4 cannot use, so a
 * single bad satellite in the cache cannot take down the whole map.
 *
 * `satrec.error` alone is not a sufficient test. satellite.js 7's
 * `sgp4init` sets `error = 0` unconditionally — its one invalid-elements
 * check is commented out upstream as "unnecessary" — so unparseable lines
 * come back as a SatRec whose numeric fields are all NaN with no error
 * flagged. Propagating that returns a *non-null* result carrying
 * `{x: null, y: null, z: null}`, which converts to NaN latitude and
 * longitude and would draw a satellite at an impossible point on the map.
 * Checking the parsed elements ourselves is the only reliable guard. */
export function toSatrec(tle: { line1: string; line2: string }): SatRec | null {
  try {
    const satrec = twoline2satrec(tle.line1, tle.line2);
    if (satrec.error !== 0) return null;
    if (!Number.isFinite(satrec.no) || !Number.isFinite(satrec.jdsatepoch)) return null;
    return satrec;
  } catch {
    return null;
  }
}

/** satellite.js v7's propagate returns null on failure — it does not
 * return `{ position: false }` as v5 did. Every caller must handle null.
 *
 * The finite check is the second half of toSatrec's guard: propagate can
 * hand back a populated object whose components are null, and a NaN
 * subpoint drawn on the canvas is a far worse failure than a missing one. */
export function subpoint(satrec: SatRec, date: Date): Subpoint | null {
  const pv = propagate(satrec, date);
  if (!pv) return null;
  const geo = eciToGeodetic(pv.position, gstime(date));
  const lat = degreesLat(geo.latitude);
  const lon = degreesLong(geo.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(geo.height)) {
    return null;
  }
  return { lat, lon, altKm: geo.height };
}

/** Same two-layer guard as subpoint, and for a sharper reason: passes.ts
 * brackets a pass with `elevation < 0` and `elevation >= 0` comparisons,
 * and BOTH are false for NaN. An unguarded NaN elevation would not throw
 * or log — the satellite would simply never appear to rise, silently
 * vanishing from pass prediction. Returning null makes the absence
 * explicit at the boundary. */
export function lookAngles(
  satrec: SatRec,
  observer: Observer,
  date: Date,
): LookAngles | null {
  const pv = propagate(satrec, date);
  if (!pv) return null;
  const look = ecfToLookAngles(
    observerGeodetic(observer),
    eciToEcf(pv.position, gstime(date)),
  );
  const elevationDeg = radiansToDegrees(look.elevation);
  const azimuthDeg = radiansToDegrees(look.azimuth);
  if (
    !Number.isFinite(elevationDeg) || !Number.isFinite(azimuthDeg) ||
    !Number.isFinite(look.rangeSat)
  ) {
    return null;
  }
  return { elevationDeg, azimuthDeg, rangeKm: look.rangeSat };
}

/** Inclusive of both endpoints. Points SGP4 cannot produce are skipped
 * rather than breaking the run of the track. */
export function groundTrack(
  satrec: SatRec,
  from: Date,
  to: Date,
  stepSec: number,
): GeoPoint[] {
  const out: GeoPoint[] = [];
  for (let t = from.getTime(); t <= to.getTime(); t += stepSec * 1000) {
    const sp = subpoint(satrec, new Date(t));
    if (sp) out.push({ lat: sp.lat, lon: sp.lon });
  }
  return out;
}

/** Angular radius of the circle on the ground from which the satellite is
 * above the horizon — about 28 degrees, or 3150 km, for a NOAA orbit. */
export function footprintRadiusDeg(altKm: number): number {
  return radiansToDegrees(Math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + altKm)));
}
