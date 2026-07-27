import { assert, assertEquals } from "@std/assert";

import { project, splitAtAntimeridian } from "./projection.ts";

Deno.test("project maps the corners and centre of the map", () => {
  assertEquals(project(0, 0, 800, 400), { x: 400, y: 200 });
  assertEquals(project(90, -180, 800, 400), { x: 0, y: 0 });
  assertEquals(project(-90, 180, 800, 400), { x: 800, y: 400 });
});

Deno.test("project puts northern latitudes above southern ones", () => {
  assert(project(45, 0, 800, 400).y < project(-45, 0, 800, 400).y);
});

Deno.test("project puts eastern longitudes right of western ones", () => {
  assert(project(0, 90, 800, 400).x > project(0, -90, 800, 400).x);
});

Deno.test("splitAtAntimeridian breaks a track that crosses 180", () => {
  const segments = splitAtAntimeridian([
    { lon: 170, lat: 0 },
    { lon: 178, lat: 1 },
    { lon: -178, lat: 2 },
    { lon: -170, lat: 3 },
  ]);
  assertEquals(segments.length, 2);
  assertEquals(segments[0].map((p) => p.lon), [170, 178]);
  assertEquals(segments[1].map((p) => p.lon), [-178, -170]);
});

Deno.test("splitAtAntimeridian leaves a non-crossing track whole", () => {
  const segments = splitAtAntimeridian([{ lon: 10 }, { lon: 20 }, { lon: 30 }]);
  assertEquals(segments.length, 1);
  assertEquals(segments[0].length, 3);
});

Deno.test("splitAtAntimeridian splits a track passing through 180", () => {
  // 180 -> -179 is a 359 degree jump, which is the wrap this exists for.
  assertEquals(splitAtAntimeridian([{ lon: 179 }, { lon: 180 }, { lon: -179 }]).length, 2);
});

Deno.test("a jump of exactly 180 degrees does not split", () => {
  // The threshold is `> 180`, so a diff of exactly 180 is treated as a
  // real movement rather than a wrap. This case is unreachable with real
  // data — ground tracks are sampled every 30s and footprint vertices
  // every 4 degrees, so neither can step half the globe at once — but the
  // boundary is pinned here so a future change to the comparison is a
  // deliberate decision rather than an accident.
  assertEquals(splitAtAntimeridian([{ lon: 0 }, { lon: 180 }]).length, 1);
  assertEquals(splitAtAntimeridian([{ lon: -90 }, { lon: 90 }]).length, 1);
});

Deno.test("splitAtAntimeridian preserves every other property", () => {
  // Task 12 splits ground tracks and footprint polygons, then reads `lat`
  // off the resulting points. An implementation that rebuilt the objects
  // from `lon` alone would pass every other test in this file and draw
  // nothing but flat lines on the map.
  const segments = splitAtAntimeridian([
    { lon: 170, lat: 10, id: "a" },
    { lon: -170, lat: 20, id: "b" },
  ]);
  assertEquals(segments.length, 2);
  assertEquals(segments[0][0], { lon: 170, lat: 10, id: "a" });
  assertEquals(segments[1][0], { lon: -170, lat: 20, id: "b" });
});

Deno.test("splitAtAntimeridian handles empty and single-point input", () => {
  assertEquals(splitAtAntimeridian([]), []);
  assertEquals(splitAtAntimeridian([{ lon: 5 }]).length, 1);
});
