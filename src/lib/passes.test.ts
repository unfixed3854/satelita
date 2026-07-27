import { assert, assertEquals } from "@std/assert";

import { lookAngles, toSatrec } from "./orbit.ts";
import { nextPasses } from "./passes.ts";

const N19 = {
  line1: "1 33591U 09005A   26207.61995983  .00000042  00000+0  46283-4 0  9994",
  line2: "2 33591  98.9503 278.5194 0012694 279.3580  80.6157 14.13479705900051",
};
const WARSAW = { lat: 52.23, lon: 21.01, altM: 100 };
const FROM = new Date("2026-07-27T00:00:00Z");

function satrec() {
  const s = toSatrec(N19);
  if (!s) throw new Error("elements should be valid");
  return s;
}

Deno.test("nextPasses finds a plausible number of passes in 24 hours", () => {
  const passes = nextPasses("19", satrec(), WARSAW, FROM, 24);
  // A prototype against these exact elements and this exact station found
  // 9 (NOAA-15 gave 8, NOAA-18 gave 9). The band leaves room for boundary
  // passes without letting a broken search pass silently.
  assert(passes.length >= 5 && passes.length <= 12, `found ${passes.length}`);
});

Deno.test("each pass is internally consistent", () => {
  for (const p of nextPasses("19", satrec(), WARSAW, FROM, 24)) {
    assert(p.aos < p.los, "AOS must precede LOS");
    const minutes = (p.los.getTime() - p.aos.getTime()) / 60_000;
    assert(minutes > 0 && minutes < 20, `implausible duration ${minutes} min`);
    assert(p.maxElevationDeg > 0, `max elevation ${p.maxElevationDeg}`);
    assert(p.maxElevationDeg <= 90, `max elevation ${p.maxElevationDeg}`);
    assertEquals(p.satId, "19");
  }
});

Deno.test("elevation is near zero at the horizon crossings", () => {
  const rec = satrec();
  for (const p of nextPasses("19", rec, WARSAW, FROM, 24)) {
    const atAos = lookAngles(rec, WARSAW, p.aos);
    const atLos = lookAngles(rec, WARSAW, p.los);
    assert(atAos !== null && atLos !== null);
    assert(Math.abs(atAos.elevationDeg) < 0.3, `AOS elevation ${atAos.elevationDeg}`);
    assert(Math.abs(atLos.elevationDeg) < 0.3, `LOS elevation ${atLos.elevationDeg}`);
  }
});

Deno.test("passes come back in chronological order and inside the window", () => {
  const passes = nextPasses("19", satrec(), WARSAW, FROM, 24);
  const until = FROM.getTime() + 24 * 3600_000;
  for (let i = 0; i < passes.length; i++) {
    assert(passes[i].aos.getTime() >= FROM.getTime(), "pass starts before the window");
    assert(passes[i].aos.getTime() <= until, "pass starts after the window");
    if (i > 0) assert(passes[i - 1].los <= passes[i].aos, "passes overlap");
  }
});

Deno.test("azimuths are reported in range", () => {
  for (const p of nextPasses("19", satrec(), WARSAW, FROM, 24)) {
    assert(p.aosAzimuth >= 0 && p.aosAzimuth <= 360, `AOS azimuth ${p.aosAzimuth}`);
    assert(p.losAzimuth >= 0 && p.losAzimuth <= 360, `LOS azimuth ${p.losAzimuth}`);
  }
});

Deno.test("a station at the antipode of the orbit still returns a sane list", () => {
  // A polar orbiter is visible from everywhere eventually; the point of
  // this case is that the search terminates and returns valid structures.
  const passes = nextPasses("19", satrec(), { lat: 0, lon: 0, altM: 0 }, FROM, 24);
  for (const p of passes) assert(p.aos < p.los);
});

Deno.test("a zero-hour window yields no passes", () => {
  assertEquals(nextPasses("19", satrec(), WARSAW, FROM, 0).length, 0);
});
