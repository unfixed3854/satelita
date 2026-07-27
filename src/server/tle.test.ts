import { assertEquals } from "@std/assert";

import { isValidTleLine, parseTleText, tleChecksum } from "./tle.ts";

// Real element sets fetched from Celestrak (epoch 26207). Every line here
// carries its genuine checksum digit — do not retype or "tidy" them, and do
// not adjust the expected values below to make a failing test pass. If these
// ever fail, the implementation is wrong, not the data.
const N19_L1 = "1 33591U 09005A   26207.61995983  .00000042  00000+0  46283-4 0  9994";
const N19_L2 = "2 33591  98.9503 278.5194 0012694 279.3580  80.6157 14.13479705900051";
const N15_L1 = "1 25338U 98030A   26207.58735544  .00000131  00000+0  71180-4 0  9994";
const N15_L2 = "2 25338  98.5066 227.1548 0009309 227.3169 132.7228 14.27157066466917";
// NOAA-18's catalog number spliced into NOAA-15's real elements, with the
// checksum digit recomputed for the new body text. Only used to exercise
// the cache-merge logic below, never propagated, so physical accuracy for
// NOAA-18 itself does not matter here.
const N18_L1 = "1 28654U 98030A   26207.58735544  .00000131  00000+0  71180-4 0  9998";
const N18_L2 = "2 28654  98.5066 227.1548 0009309 227.3169 132.7228 14.27157066466911";

Deno.test("tleChecksum sums digits with '-' counting as one", () => {
  // The checksum is the last character; the sum is taken over the first 68.
  assertEquals(tleChecksum(N19_L1), 4);
  assertEquals(tleChecksum(N19_L2), 1);
});

Deno.test("isValidTleLine accepts real element lines", () => {
  assertEquals(isValidTleLine(N19_L1), true);
  assertEquals(isValidTleLine(N19_L2), true);
});

Deno.test("isValidTleLine rejects a corrupted line", () => {
  // Flip a digit in the body without fixing the checksum.
  const corrupted = `${N19_L1.slice(0, 20)}9${N19_L1.slice(21)}`;
  assertEquals(isValidTleLine(corrupted), false);
});

Deno.test("isValidTleLine rejects a truncated line", () => {
  assertEquals(isValidTleLine(N19_L1.slice(0, 40)), false);
});

Deno.test("isValidTleLine rejects a 69-character line whose final character is not a digit", () => {
  const nonDigitChecksum = `${N19_L1.slice(0, 68)}X`;
  assertEquals(nonDigitChecksum.length, 69);
  assertEquals(isValidTleLine(nonDigitChecksum), false);
});

Deno.test("parseTleText keys the three NOAA satellites by short id", () => {
  const text = `NOAA 19\n${N19_L1}\n${N19_L2}\nNOAA 15\n${N15_L1}\n${N15_L2}\n`;
  const parsed = parseTleText(text);
  assertEquals(Object.keys(parsed).sort(), ["15", "19"]);
  assertEquals(parsed["19"].name, "NOAA 19");
  assertEquals(parsed["19"].line1, N19_L1);
  assertEquals(parsed["15"].line2, N15_L2);
});

Deno.test("parseTleText ignores satellites outside the catalog", () => {
  // Real DMSP 5D-3 F16 elements — a weather satellite that is not an APT
  // satellite, so it must be filtered out by catalog number.
  const other1 = "1 28054U 03048A   26207.58535321  .00000021  00000+0  34680-4 0  9990";
  const other2 = "2 28054  98.9888 231.6728 0007770  42.8290 122.8338 14.14485310175052";
  const text = `DMSP 5D-3 F16 (USA 172)\n${other1}\n${other2}\nNOAA 19\n${N19_L1}\n${N19_L2}\n`;
  assertEquals(Object.keys(parseTleText(text)), ["19"]);
});

Deno.test("parseTleText handles Celestrak's CRLF line endings", () => {
  // Celestrak serves \r\n and pads name lines with trailing spaces. Both
  // would push every line past the 69-character check if left in place.
  const text = `NOAA 19                 \r\n${N19_L1}\r\n${N19_L2}\r\n`;
  const parsed = parseTleText(text);
  assertEquals(Object.keys(parsed), ["19"]);
  assertEquals(parsed["19"].name, "NOAA 19");
  assertEquals(parsed["19"].line1, N19_L1);
});

Deno.test("parseTleText drops element sets that fail validation", () => {
  const corrupted = `${N19_L1.slice(0, 20)}9${N19_L1.slice(21)}`;
  assertEquals(parseTleText(`NOAA 19\n${corrupted}\n${N19_L2}\n`), {});
});

import { assert, assertRejects } from "@std/assert";

import { getTles } from "./tle.ts";

// getTles issues one request per satellite, so the stub answers based on
// the CATNR in the URL — mirroring Celestrak's real per-satellite responses.
const RESPONSES: Record<string, string> = {
  "25338": `NOAA 15                 \r\n${N15_L1}\r\n${N15_L2}\r\n`,
  "33591": `NOAA 19                 \r\n${N19_L1}\r\n${N19_L2}\r\n`,
  "28654": "No GP data found",
};

function stubFetch(bodies: Record<string, string> = RESPONSES, status = 200): typeof fetch {
  return ((url: string) => {
    const catnr = new URL(url).searchParams.get("CATNR") ?? "";
    return Promise.resolve(new Response(bodies[catnr] ?? "No GP data found", { status }));
  }) as unknown as typeof fetch;
}

const failingFetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;

Deno.test("getTles fetches and writes a cache when none exists", async () => {
  const dir = await Deno.makeTempDir();
  const result = await getTles({ fetchImpl: stubFetch(), dir });

  // NOAA-18's stubbed response carries no elements, so a partial result is
  // the expected outcome — one satellite Celestrak cannot serve must not
  // cost us the other two.
  assertEquals(Object.keys(result.sats).sort(), ["15", "19"]);
  assertEquals(result.stale, false);

  const cached = JSON.parse(await Deno.readTextFile(`${dir}/tle.json`));
  assertEquals(Object.keys(cached.sats).sort(), ["15", "19"]);
});

Deno.test("getTles requests each catalogued satellite once", async () => {
  const dir = await Deno.makeTempDir();
  const seen: string[] = [];
  const spy = ((url: string) => {
    const catnr = new URL(url).searchParams.get("CATNR") ?? "";
    seen.push(catnr);
    return Promise.resolve(new Response(RESPONSES[catnr] ?? "No GP data found"));
  }) as unknown as typeof fetch;

  await getTles({ fetchImpl: spy, dir });
  assertEquals(seen.sort(), ["25338", "28654", "33591"]);
});

Deno.test("getTles serves a fresh cache without any network call", async () => {
  const dir = await Deno.makeTempDir();
  await getTles({ fetchImpl: stubFetch(), dir });

  let called = false;
  const spy = (() => {
    called = true;
    return Promise.reject(new Error("should not be called"));
  }) as unknown as typeof fetch;

  const result = await getTles({ fetchImpl: spy, dir });
  assertEquals(called, false);
  assertEquals(result.stale, false);
  assertEquals(Object.keys(result.sats).sort(), ["15", "19"]);
});

Deno.test("getTles refetches once the cache passes 24 hours", async () => {
  const dir = await Deno.makeTempDir();
  const t0 = new Date("2026-07-01T00:00:00Z");
  await getTles({ fetchImpl: stubFetch(), dir, now: t0 });

  const later = new Date("2026-07-02T01:00:00Z");
  const result = await getTles({ fetchImpl: stubFetch(), dir, now: later });
  assertEquals(result.fetchedAt, later.toISOString());
  assertEquals(result.stale, false);
});

Deno.test("getTles falls back to a stale cache when the network fails", async () => {
  const dir = await Deno.makeTempDir();
  const t0 = new Date("2026-07-01T00:00:00Z");
  await getTles({ fetchImpl: stubFetch(), dir, now: t0 });

  const later = new Date("2026-07-10T00:00:00Z");
  const result = await getTles({ fetchImpl: failingFetch, dir, now: later });
  assertEquals(result.stale, true);
  assertEquals(result.fetchedAt, t0.toISOString());
  assertEquals(Object.keys(result.sats).sort(), ["15", "19"]);
});

Deno.test("getTles throws when there is no cache and no network", async () => {
  const dir = await Deno.makeTempDir();
  await assertRejects(() => getTles({ fetchImpl: failingFetch, dir }));
});

Deno.test("getTles keeps a good cache when every response is garbage", async () => {
  const dir = await Deno.makeTempDir();
  const t0 = new Date("2026-07-01T00:00:00Z");
  await getTles({ fetchImpl: stubFetch(), dir, now: t0 });

  const captivePortal = stubFetch({
    "25338": "<html>captive portal</html>",
    "28654": "<html>captive portal</html>",
    "33591": "<html>captive portal</html>",
  });
  const later = new Date("2026-07-10T00:00:00Z");
  const result = await getTles({ fetchImpl: captivePortal, dir, now: later });
  assertEquals(result.stale, true);
  assertEquals(Object.keys(result.sats).sort(), ["15", "19"]);
});

Deno.test("getTles keeps a good cache when every request errors", async () => {
  const dir = await Deno.makeTempDir();
  const t0 = new Date("2026-07-01T00:00:00Z");
  await getTles({ fetchImpl: stubFetch(), dir, now: t0 });

  const later = new Date("2026-07-10T00:00:00Z");
  const result = await getTles({ fetchImpl: stubFetch(RESPONSES, 503), dir, now: later });
  assertEquals(result.stale, true);
  assertEquals(Object.keys(result.sats).sort(), ["15", "19"]);
});

const FULL_RESPONSES: Record<string, string> = {
  "25338": `NOAA 15                 \r\n${N15_L1}\r\n${N15_L2}\r\n`,
  "28654": `NOAA 18                 \r\n${N18_L1}\r\n${N18_L2}\r\n`,
  "33591": `NOAA 19                 \r\n${N19_L1}\r\n${N19_L2}\r\n`,
};

Deno.test("getTles keeps a satellite's cached elements when only it fails to refresh", async () => {
  const dir = await Deno.makeTempDir();
  const t0 = new Date("2026-07-01T00:00:00Z");
  await getTles({ fetchImpl: stubFetch(FULL_RESPONSES), dir, now: t0 });

  // Day two: NOAA-19 alone comes back empty, the other two refresh fine.
  const laterStub = stubFetch({ ...FULL_RESPONSES, "33591": "No GP data found" });
  const later = new Date("2026-07-02T00:00:00Z");
  const result = await getTles({ fetchImpl: laterStub, dir, now: later });

  // NOAA-19 must not be evicted — it keeps its day-one cached elements
  // instead of vanishing because this round's fetch for it failed.
  assertEquals(Object.keys(result.sats).sort(), ["15", "18", "19"]);
  assertEquals(result.sats["19"], { name: "NOAA 19", line1: N19_L1, line2: N19_L2 });
});

Deno.test("getTles reports stale when a satellite's elements came from cache rather than a fresh fetch", async () => {
  const dir = await Deno.makeTempDir();
  const t0 = new Date("2026-07-01T00:00:00Z");
  await getTles({ fetchImpl: stubFetch(FULL_RESPONSES), dir, now: t0 });

  const laterStub = stubFetch({ ...FULL_RESPONSES, "33591": "No GP data found" });
  const later = new Date("2026-07-02T00:00:00Z");
  const result = await getTles({ fetchImpl: laterStub, dir, now: later });

  assertEquals(result.stale, true);
});

Deno.test("getTles recovers from a corrupt cache file", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/tle.json`, "{not json");
  const result = await getTles({ fetchImpl: stubFetch(), dir });
  assert(Object.keys(result.sats).length > 0);
});
