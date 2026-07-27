import { assert, assertEquals } from "@std/assert";

import {
  footprintRadiusDeg,
  groundTrack,
  lookAngles,
  subpoint,
  toSatrec,
} from "./orbit.ts";

// Real NOAA-19 elements from Celestrak, epoch 26207. The date is fixed so
// every assertion below is deterministic rather than drifting with the
// wall clock — SGP4 propagates from the element epoch, not from "now".
const N19 = {
  line1: "1 33591U 09005A   26207.61995983  .00000042  00000+0  46283-4 0  9994",
  line2: "2 33591  98.9503 278.5194 0012694 279.3580  80.6157 14.13479705900051",
};
const AT = new Date("2026-07-27T12:00:00Z");

Deno.test("toSatrec returns null for unusable elements", () => {
  // satellite.js 7 does NOT flag these: twoline2satrec returns a SatRec
  // full of NaN with error === 0, and propagating it yields a non-null
  // result carrying null components. Verified against the installed
  // library — if this test fails, the NaN guard has been removed.
  assertEquals(toSatrec({ line1: "garbage", line2: "garbage" }), null);
  assertEquals(toSatrec({ line1: "", line2: "" }), null);
  assertEquals(toSatrec({ line1: "1 33591U 09005A", line2: "2 33591" }), null);
});

Deno.test("a satrec that survives toSatrec never yields a NaN subpoint", () => {
  const satrec = toSatrec(N19);
  assert(satrec !== null);
  // Well past the element epoch, where SGP4 accuracy collapses, subpoint
  // must still return either real coordinates or null — never NaN.
  for (const daysOut of [0, 30, 365, 3650]) {
    const sp = subpoint(satrec, new Date(AT.getTime() + daysOut * 86_400_000));
    if (sp === null) continue;
    assert(Number.isFinite(sp.lat) && Number.isFinite(sp.lon), `NaN at +${daysOut}d`);
    assert(Number.isFinite(sp.altKm), `NaN altitude at +${daysOut}d`);
  }
});

Deno.test("subpoint puts NOAA-19 in its ~850km orbit", () => {
  const satrec = toSatrec(N19);
  assert(satrec !== null);
  const sp = subpoint(satrec, AT);
  assert(sp !== null);

  // Verified against satellite.js directly with these exact elements.
  assert(Math.abs(sp.lat - 24.2397) < 0.01, `lat ${sp.lat}`);
  assert(Math.abs(sp.lon - -21.7382) < 0.01, `lon ${sp.lon}`);
  assert(Math.abs(sp.altKm - 855.18) < 1, `alt ${sp.altKm}`);
});

Deno.test("subpoint always returns degrees in range", () => {
  const satrec = toSatrec(N19);
  assert(satrec !== null);
  for (let i = 0; i < 200; i++) {
    const sp = subpoint(satrec, new Date(AT.getTime() + i * 60_000));
    assert(sp !== null);
    assert(sp.lat >= -90 && sp.lat <= 90, `lat out of range: ${sp.lat}`);
    assert(sp.lon >= -180 && sp.lon <= 180, `lon out of range: ${sp.lon}`);
  }
});

Deno.test("lookAngles reports a plausible range and elevation", () => {
  const satrec = toSatrec(N19);
  assert(satrec !== null);
  const look = lookAngles(satrec, { lat: 52.23, lon: 21.01, altM: 100 }, AT);
  assert(look !== null);

  // Verified against satellite.js: elevation -12.216, azimuth 245.931,
  // range 5019.36 km. Below the horizon, so not a recordable pass.
  assert(Math.abs(look.elevationDeg - -12.216) < 0.01, `elevation ${look.elevationDeg}`);
  assert(Math.abs(look.azimuthDeg - 245.931) < 0.01, `azimuth ${look.azimuthDeg}`);
  assert(Math.abs(look.rangeKm - 5019.36) < 1, `range ${look.rangeKm}`);
});

Deno.test("groundTrack samples the requested window at the requested step", () => {
  const satrec = toSatrec(N19);
  assert(satrec !== null);
  const from = AT;
  const to = new Date(AT.getTime() + 60 * 60_000);
  const track = groundTrack(satrec, from, to, 60);

  assertEquals(track.length, 61);
  for (const p of track) {
    assert(p.lat >= -90 && p.lat <= 90);
    assert(p.lon >= -180 && p.lon <= 180);
  }
});

Deno.test("footprintRadiusDeg matches the geometry for a NOAA orbit", () => {
  // acos(6371 / (6371 + 868.9)) = 28.36 degrees.
  assert(Math.abs(footprintRadiusDeg(868.9) - 28.3595) < 0.001);
  // A higher orbit sees more of the planet.
  assert(footprintRadiusDeg(35786) > footprintRadiusDeg(868.9));
});
