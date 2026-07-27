import { assert, assertEquals } from "@std/assert";

import { enclosedPole, footprintPolygon } from "./footprint.ts";

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Great-circle angular distance, used to check the polygon independently
 * of the formula that produced it. */
function angularDistanceDeg(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const c = Math.sin(rad(aLat)) * Math.sin(rad(bLat)) +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.cos(rad(aLon - bLon));
  return deg(Math.acos(Math.min(1, Math.max(-1, c))));
}

Deno.test("every vertex sits exactly the given radius from the subpoint", () => {
  for (const [lat, lon] of [[0, 0], [45, -120], [-80.99, -125.6], [88, 170]]) {
    for (const p of footprintPolygon(lat, lon, 28.36)) {
      const d = angularDistanceDeg(lat, lon, p.lat, p.lon);
      assert(Math.abs(d - 28.36) < 1e-6, `subpoint ${lat},${lon}: got ${d}`);
    }
  }
});

Deno.test("vertices stay inside valid coordinate ranges", () => {
  for (const p of footprintPolygon(88, 170, 28.36)) {
    assert(p.lat >= -90 && p.lat <= 90, `lat ${p.lat}`);
    assert(p.lon >= -180 && p.lon <= 180, `lon ${p.lon}`);
  }
});

Deno.test("the polygon closes and honours the step count", () => {
  const poly = footprintPolygon(10, 20, 28.36, 90);
  assertEquals(poly.length, 91);
  assert(Math.abs(poly[0].lat - poly[90].lat) < 1e-9);
  assert(Math.abs(poly[0].lon - poly[90].lon) < 1e-9);
});

Deno.test("a high-latitude footprint reaches every longitude sector", () => {
  const lons = footprintPolygon(-80.99, -125.6, 28.36).map((p) => p.lon);
  for (const sector of [-150, -90, -30, 30, 90, 150]) {
    assert(lons.some((l) => Math.abs(l - sector) < 45), `no vertex near lon ${sector}`);
  }
});

Deno.test("an equatorial footprint stays within its radius in longitude", () => {
  const lons = footprintPolygon(0, 0, 28.36).map((p) => p.lon);
  assert(Math.max(...lons) < 29 && Math.min(...lons) > -29);
});

Deno.test("enclosedPole names the pole a footprint swallows", () => {
  assertEquals(enclosedPole(-80.99, 28.36), "south");
  assertEquals(enclosedPole(80.99, 28.36), "north");
  assertEquals(enclosedPole(0, 28.36), null);
  assertEquals(enclosedPole(61, 28.36), null);
  assertEquals(enclosedPole(62, 28.36), "north");
});
