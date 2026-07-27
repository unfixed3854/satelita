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

Deno.test("splitAtAntimeridian splits at exactly 180", () => {
  assertEquals(splitAtAntimeridian([{ lon: 179 }, { lon: 180 }, { lon: -179 }]).length, 2);
});

Deno.test("splitAtAntimeridian handles empty and single-point input", () => {
  assertEquals(splitAtAntimeridian([]), []);
  assertEquals(splitAtAntimeridian([{ lon: 5 }]).length, 1);
});
