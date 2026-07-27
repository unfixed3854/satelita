import { assertEquals, assertRejects } from "@std/assert";

import { isValidStation, readStation, writeStation } from "./station.ts";

const WARSAW = { lat: 52.23, lon: 21.01, altM: 100, source: "manual" as const };

Deno.test("readStation returns null when nothing has been saved", async () => {
  const dir = await Deno.makeTempDir();
  assertEquals(await readStation(dir), null);
});

Deno.test("writeStation then readStation round-trips", async () => {
  const dir = await Deno.makeTempDir();
  await writeStation(WARSAW, dir);
  assertEquals(await readStation(dir), WARSAW);
});

Deno.test("readStation treats a corrupt file as unset", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/station.json`, "{{{");
  assertEquals(await readStation(dir), null);
});

Deno.test("readStation treats out-of-range coordinates as unset", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${dir}/station.json`,
    JSON.stringify({ lat: 991, lon: 21.01, altM: 0, source: "manual" }),
  );
  assertEquals(await readStation(dir), null);
});

Deno.test("writeStation rejects invalid coordinates", async () => {
  const dir = await Deno.makeTempDir();
  await assertRejects(() => writeStation({ ...WARSAW, lon: 400 }, dir));
  await assertRejects(() => writeStation({ ...WARSAW, lat: Number.NaN }, dir));
});

Deno.test("isValidStation checks ranges and shape", () => {
  assertEquals(isValidStation(WARSAW), true);
  assertEquals(isValidStation({ ...WARSAW, lat: 90 }), true);
  assertEquals(isValidStation({ ...WARSAW, lat: 90.1 }), false);
  assertEquals(isValidStation({ ...WARSAW, lon: -180.1 }), false);
  assertEquals(isValidStation({ ...WARSAW, source: "guessed" }), false);
  assertEquals(isValidStation({ lat: 1, lon: 2 }), false);
  assertEquals(isValidStation(null), false);
});

Deno.test("writeStation leaves the previous file intact when it fails", async () => {
  const dir = await Deno.makeTempDir();
  await writeStation(WARSAW, dir);
  await assertRejects(() => writeStation({ ...WARSAW, lat: 1000 }, dir));
  assertEquals(await readStation(dir), WARSAW);
});
