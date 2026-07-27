import { assert } from "@std/assert";

import { isNight, subsolarPoint, terminatorLatitude } from "./terminator.ts";

Deno.test("subsolarPoint finds the sun over the Tropic of Cancer at solstice", () => {
  const sub = subsolarPoint(new Date("2024-06-20T12:00:00Z"));
  // Verified against satellite.js's own Vallado sun model: 23.4356, 0.4268.
  assert(Math.abs(sub.lat - 23.44) < 0.2, `declination ${sub.lat}`);
  assert(Math.abs(sub.lon) < 5, `subsolar longitude ${sub.lon}`);
});

Deno.test("subsolarPoint finds the sun south of the equator in December", () => {
  const sub = subsolarPoint(new Date("2024-12-21T12:00:00Z"));
  assert(Math.abs(sub.lat - -23.44) < 0.2, `declination ${sub.lat}`);
});

Deno.test("subsolarPoint tracks the sun westward through the day", () => {
  const noon = subsolarPoint(new Date("2024-03-20T12:00:00Z"));
  const later = subsolarPoint(new Date("2024-03-20T18:00:00Z"));
  // Six hours is a quarter turn: the subsolar point moves 90 degrees west.
  let delta = later.lon - noon.lon;
  delta = ((((delta + 540) % 360) + 360) % 360) - 180;
  assert(Math.abs(delta - -90) < 2, `moved ${delta} degrees`);
});

Deno.test("subsolarPoint stays inside valid coordinate ranges", () => {
  for (let h = 0; h < 24; h++) {
    const sub = subsolarPoint(new Date(Date.UTC(2024, 5, 20, h)));
    assert(sub.lat >= -90 && sub.lat <= 90, `lat ${sub.lat}`);
    assert(sub.lon >= -180 && sub.lon <= 180, `lon ${sub.lon}`);
  }
});

Deno.test("the terminator curve separates day from night", () => {
  const sub = { lat: 23.44, lon: 0 };
  for (const lon of [-170, -90, -30, 0, 45, 120, 179]) {
    const tLat = terminatorLatitude(lon, sub);
    const above = isNight(tLat + 0.5, lon, sub);
    const below = isNight(tLat - 0.5, lon, sub);
    assert(above !== below, `lon ${lon}: curve at ${tLat} separates nothing`);
    // With a northern-summer sun, the dark side is to the south.
    assert(below, `lon ${lon}: south of the terminator should be night`);
  }
});

Deno.test("polar day and polar night", () => {
  const june = { lat: 23.44, lon: 0 };
  for (const lon of [-180, -90, 0, 90, 180]) {
    assert(!isNight(89, lon, june), `north pole should be lit at lon ${lon}`);
    assert(isNight(-89, lon, june), `south pole should be dark at lon ${lon}`);
  }
});

Deno.test("terminatorLatitude stays finite at the equinox", () => {
  // Declination near zero would divide by tan(0) without the clamp.
  const sub = { lat: 0, lon: 0 };
  for (const lon of [-180, -90, 0, 90, 180]) {
    const tLat = terminatorLatitude(lon, sub);
    assert(Number.isFinite(tLat), `lon ${lon} gave ${tLat}`);
  }
});

Deno.test("isNight agrees with local time of day", () => {
  // Midnight over Greenwich: the sun is on the far side of the planet.
  const midnight = subsolarPoint(new Date("2024-03-20T00:00:00Z"));
  assert(isNight(51.5, 0, midnight));
  const noon = subsolarPoint(new Date("2024-03-20T12:00:00Z"));
  assert(!isNight(51.5, 0, noon));
});
