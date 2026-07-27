// A satellite's footprint is a circle on the sphere, which equirectangular
// projection turns into a distorted oval — and NOAA's 98-degree inclination
// puts these satellites at high latitude often enough that the shape
// regularly wraps around a pole. Sampling the circle in spherical
// coordinates and projecting the samples is the only approach that stays
// correct there; a canvas arc() would look right near the equator and
// visibly wrong exactly when it matters.

import type { GeoPoint } from "@/lib/orbit";

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Vertices of the footprint boundary, walking a full circle of bearings
 * out from the subpoint via the great-circle destination-point formula.
 * The first and last vertex coincide, so the path closes. */
export function footprintPolygon(
  lat: number,
  lon: number,
  radiusDeg: number,
  steps = 90,
): GeoPoint[] {
  const lat1 = toRad(lat);
  const lon1 = toRad(lon);
  const d = toRad(radiusDeg);
  const out: GeoPoint[] = [];

  for (let i = 0; i <= steps; i++) {
    const bearing = (i / steps) * 2 * Math.PI;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearing),
    );
    const lon2 = lon1 + Math.atan2(
      Math.sin(bearing) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
    out.push({
      lat: toDeg(lat2),
      // Normalise into [-180, 180]; the +540 shift keeps the modulo
      // positive for the westward bearings.
      lon: ((toDeg(lon2) + 540) % 360) - 180,
    });
  }
  return out;
}

/** Which pole, if either, falls inside the footprint. The renderer needs
 * this because such a polygon has no closed outline in equirectangular
 * space — it has to be closed along the top or bottom map edge instead. */
export function enclosedPole(lat: number, radiusDeg: number): "north" | "south" | null {
  if (lat + radiusDeg > 90) return "north";
  if (lat - radiusDeg < -90) return "south";
  return null;
}
