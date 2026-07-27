# Satellite Tracking Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/tracking` route with a live offline world map of NOAA-15/18/19 and a 24-hour list of upcoming passes over the operator's ground station.

**Architecture:** Orbital position is a pure function of `(elements, time)`, so SGP4 propagation runs in the browser via `satellite.js`. The server does only what the browser cannot: fetching and disk-caching TLEs from Celestrak, persisting the station's coordinates, and making one IP-geolocation call. The map is a `<canvas>` in equirectangular projection drawing bundled Natural Earth coastlines — no tile server, no network at render time.

**Tech Stack:** TanStack Start (React 19, Vite), Deno runtime, Tailwind v4, Base UI / shadcn components, `satellite.js` v7, `world-atlas` + `topojson-client`.

**Spec:** `docs/superpowers/specs/2026-07-27-satellite-tracking-map-design.md`

## Global Constraints

- **Deno is the test runner.** `deno task test` runs `deno test --allow-env --allow-read --allow-write src/server/ src/lib/`. Only files under `src/lib/` and `src/server/` are unit-tested. Components and hooks are not.
- **Tests use `@std/assert`**, imported as `import { assertEquals } from "@std/assert";` — matching every existing `*.test.ts`.
- **No network in tests.** Every function that fetches takes a `fetch` implementation as an injectable parameter, defaulting to global `fetch`. Tests pass a stub.
- **No real app-data directory in tests.** Every function that touches disk takes its base directory as an injectable parameter, defaulting to `appDataDir()` from `src/server/paths.ts`. Tests pass `Deno.makeTempDir()`.
- **satellite.js v7 API only.** v7 differs from the v5/v6 examples common online. Verified signatures: `propagate(satrec, date)` returns `PositionAndVelocity | null` — **it returns `null` on failure, it does not return `{position: false}`**. `twoline2satrec(l1, l2)` reports failure via `satrec.error !== 0`. `gstime(date)`, `eciToGeodetic(eci, gmst)`, `eciToEcf(eci, gmst)`, `ecfToLookAngles(observerGeodetic, satelliteEcf)`, `degreesLat`, `degreesLong`, `radiansToDegrees`, `jday(date)`, `sunPos(jday)`.
- **Angles:** satellite.js works in **radians**; this codebase's own interfaces are all in **degrees**. Every wrapper converts at the boundary. `GeodeticLocation.height` is in **kilometres**.
- **Server functions live in `src/server/functions.ts`**, never in the modules themselves, matching the existing pattern. Modules stay plain, directly-testable TypeScript.
- **Import style is decided by which tool loads the file, not by taste.**
  `src/lib/` and `src/server/` are executed directly by `deno test`, and
  Deno's resolver knows nothing about the `@/` alias (it lives only in
  `vite.config.ts` and `tsconfig.json`) and requires explicit file
  extensions. So **every import inside `src/lib/` and `src/server/` must be
  relative and carry the `.ts` extension** — `./orbit.ts`, `./paths.ts`.
  Components, hooks and routes are bundled by Vite and never loaded by
  Deno, so those use the `@/` alias as the rest of the app does.
  A type-only `@/` import inside `src/lib/` appears to work because
  TypeScript erases it before Deno ever sees it — it will break the moment
  anyone adds a value import to the same module. Do not rely on it.
- **Commit after every task.** Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`).
- **Comments explain *why*, not *what*.** This codebase's comments document non-obvious reasoning and rejected alternatives. Match that density — see `src/components/signal-panel.tsx` and `src/routes/index.tsx` for the house style. Do not narrate obvious code.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/server/tle.ts` | Celestrak fetch, TLE parse + checksum validation, 24h disk cache |
| `src/server/station.ts` | `station.json` read/write with validation and atomic replace |
| `src/server/geoip.ts` | One HTTPS lookup returning approximate coordinates |
| `src/lib/orbit.ts` | satellite.js wrapper: subpoint, look angles, ground track, footprint radius |
| `src/lib/footprint.ts` | Spherical footprint polygon + pole-enclosure test |
| `src/lib/projection.ts` | Equirectangular projection + antimeridian splitting |
| `src/lib/terminator.ts` | Subsolar point, terminator curve, day/night test |
| `src/lib/passes.ts` | AOS/LOS pass search |
| `src/lib/theme.ts` | `readToken` — SSR-safe CSS custom property reader |
| `src/hooks/use-tracking.ts` | Ties TLEs + station to live positions and passes at the right cadences |
| `src/components/app-nav.tsx` | Top bar shared by both routes |
| `src/components/world-map.tsx` | Canvas renderer |
| `src/components/pass-list.tsx` | Upcoming-pass rail panel |
| `src/components/station-settings.tsx` | Coordinate entry + Detect |
| `src/routes/tracking.tsx` | `/tracking` route assembly |

**Modified:** `package.json` (deps), `src/server/functions.ts` (4 server functions), `src/routes/__root.tsx` (nav in shell), `src/routes/index.tsx` (height handoff), `src/components/signal-panel.tsx` (use extracted `readToken`), `README.md`.

---

### Task 1: Dependencies and TLE parsing

**Files:**
- Modify: `package.json`
- Create: `src/server/tle.ts`
- Test: `src/server/tle.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface TleSet { name: string; line1: string; line2: string }`; `NOAA_CATALOG: Record<string, string>`; `tleChecksum(line: string): number`; `isValidTleLine(line: string): boolean`; `parseTleText(text: string): Record<string, TleSet>`.

- [ ] **Step 1: Install dependencies**

```bash
npm install satellite.js@^7.1.0 topojson-client@^3.1.0 world-atlas@^2.0.2
npm install --save-dev @types/topojson-client@^3.1.5 @types/geojson@^7946.0.14
```

- [ ] **Step 2: Write the failing test**

Create `src/server/tle.test.ts`:

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `deno test --allow-env --allow-read --allow-write src/server/tle.test.ts`
Expected: FAIL — module `./tle.ts` not found.

- [ ] **Step 4: Write the implementation**

Create `src/server/tle.ts`:

```ts
// Orbital element sets for the three APT satellites the app records,
// fetched from Celestrak and cached to disk so the tracking map works
// offline.

/** NORAD catalog number -> the short satellite id used throughout the app
 * (and by CapturePanel's SATS list). Celestrak's "noaa" group carries far
 * more than these three; everything else is discarded on parse. */
export const NOAA_CATALOG: Record<string, string> = {
  "25338": "15",
  "28654": "18",
  "33591": "19",
};

export interface TleSet {
  name: string;
  line1: string;
  line2: string;
}

const TLE_LINE_LENGTH = 69;

/** Sum of a TLE line's first 68 characters, digits at face value and
 * minus signs as 1 (everything else as 0), which the 69th character
 * records modulo 10. */
export function tleChecksum(line: string): number {
  let sum = 0;
  for (let i = 0; i < TLE_LINE_LENGTH - 1; i++) {
    const c = line[i];
    if (c >= "0" && c <= "9") sum += c.charCodeAt(0) - 48;
    else if (c === "-") sum += 1;
  }
  return sum % 10;
}

/** A truncated download, or a captive portal's HTML, yields lines that
 * *look* like elements and that SGP4 will happily propagate into a wrong
 * orbit with no error. The checksum is the only cheap defence, so nothing
 * is allowed to replace a good cache without passing it. */
export function isValidTleLine(line: string): boolean {
  if (line.length !== TLE_LINE_LENGTH) return false;
  const last = line[TLE_LINE_LENGTH - 1];
  if (last < "0" || last > "9") return false;
  return tleChecksum(line) === last.charCodeAt(0) - 48;
}

/** Parses Celestrak's 3-line-per-satellite TLE format, keeping only the
 * NOAA_CATALOG satellites whose element sets pass validation. */
export function parseTleText(text: string): Record<string, TleSet> {
  const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0);
  const out: Record<string, TleSet> = {};

  for (let i = 0; i + 2 < lines.length; i++) {
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (!line1?.startsWith("1 ") || !line2?.startsWith("2 ")) continue;

    const satId = NOAA_CATALOG[line1.slice(2, 7).trim()];
    if (!satId) continue;
    if (!isValidTleLine(line1) || !isValidTleLine(line2)) continue;

    out[satId] = { name: lines[i].trim(), line1, line2 };
  }
  return out;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `deno test --allow-env --allow-read --allow-write src/server/tle.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/server/tle.ts src/server/tle.test.ts
git commit -m "feat: parse and validate NOAA TLE element sets"
```

---

### Task 2: TLE fetch and disk cache

**Files:**
- Modify: `src/server/tle.ts`
- Test: `src/server/tle.test.ts`

**Interfaces:**
- Consumes: `TleSet`, `parseTleText` from Task 1.
- Produces: `interface TleResult { sats: Record<string, TleSet>; fetchedAt: string; stale: boolean }`; `getTles(opts?: { fetchImpl?: typeof fetch; dir?: string; now?: Date }): Promise<TleResult>`.

- [ ] **Step 1: Write the failing test**

Append to `src/server/tle.test.ts`:

```ts
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

Deno.test("getTles recovers from a corrupt cache file", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/tle.json`, "{not json");
  const result = await getTles({ fetchImpl: stubFetch(), dir });
  assert(Object.keys(result.sats).length > 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env --allow-read --allow-write src/server/tle.test.ts`
Expected: FAIL — `getTles` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/server/tle.ts`:

```ts
import { appDataDir } from "./paths.ts";

/** Celestrak has no group containing NOAA-15/18/19 — its "weather" group
 * carries only the newer JPSS birds (NOAA 20/21), and there is no "noaa"
 * group at all. So these are fetched one CATNR at a time: three small
 * requests a day, which the 24h cache keeps well inside Celestrak's
 * usage guidance. */
function catalogUrl(catalogNumber: string): string {
  return `https://celestrak.org/NORAD/elements/gp.php?CATNR=${catalogNumber}&FORMAT=tle`;
}

/** Celestrak asks clients not to poll aggressively, and element sets are
 * only reissued a few times a day. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface TleCache {
  fetchedAt: string;
  sats: Record<string, TleSet>;
}

export interface TleResult {
  sats: Record<string, TleSet>;
  fetchedAt: string;
  /** True when these elements came from a cache that could not be
   * refreshed — the map still works, but the UI warns. */
  stale: boolean;
}

export interface GetTlesOptions {
  fetchImpl?: typeof fetch;
  dir?: string;
  now?: Date;
}

async function readCache(dir: string): Promise<TleCache | null> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(`${dir}/tle.json`)) as TleCache;
    if (typeof parsed?.fetchedAt !== "string" || typeof parsed?.sats !== "object") return null;
    if (Object.keys(parsed.sats).length === 0) return null;
    return parsed;
  } catch {
    // Missing or unparseable: both mean "no usable cache", and a refetch
    // is the recovery for either.
    return null;
  }
}

async function writeCache(dir: string, cache: TleCache): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  const tmp = `${dir}/tle.json.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(cache));
  await Deno.rename(tmp, `${dir}/tle.json`);
}

export async function getTles(opts: GetTlesOptions = {}): Promise<TleResult> {
  const dir = opts.dir ?? appDataDir();
  const now = opts.now ?? new Date();
  const fetchImpl = opts.fetchImpl ?? fetch;

  const cache = await readCache(dir);
  const fresh = cache !== null &&
    now.getTime() - new Date(cache.fetchedAt).getTime() < CACHE_TTL_MS;
  if (cache && fresh) {
    return { sats: cache.sats, fetchedAt: cache.fetchedAt, stale: false };
  }

  try {
    // Per-satellite results are merged, and one satellite failing is
    // survivable: Celestrak occasionally has no current elements for a
    // given bird, and losing all three over one 404 would be worse than
    // drawing the two that did arrive.
    const results = await Promise.all(
      Object.keys(NOAA_CATALOG).map(async (catalogNumber) => {
        try {
          const res = await fetchImpl(catalogUrl(catalogNumber));
          if (!res.ok) return {};
          // An unparseable body is not a TLE feed at all — Celestrak's
          // "No GP data found", a captive portal, an error page. Treated
          // exactly like a failed request.
          return parseTleText(await res.text());
        } catch {
          return {};
        }
      }),
    );

    const sats = Object.assign({}, ...results) as Record<string, TleSet>;
    if (Object.keys(sats).length === 0) throw new Error("No usable element sets in response");

    const updated: TleCache = { fetchedAt: now.toISOString(), sats };
    await writeCache(dir, updated);
    return { sats, fetchedAt: updated.fetchedAt, stale: false };
  } catch (err) {
    if (cache) return { sats: cache.sats, fetchedAt: cache.fetchedAt, stale: true };
    throw err;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env --allow-read --allow-write src/server/tle.test.ts`
Expected: PASS — 17 tests (8 from Task 1, 9 here).

- [ ] **Step 5: Commit**

```bash
git add src/server/tle.ts src/server/tle.test.ts
git commit -m "feat: cache NOAA element sets on disk with offline fallback"
```

---

### Task 3: Station persistence

**Files:**
- Create: `src/server/station.ts`
- Test: `src/server/station.test.ts`

**Interfaces:**
- Consumes: `appDataDir` from `src/server/paths.ts`.
- Produces: `interface Station { lat: number; lon: number; altM: number; source: "auto" | "manual" }`; `isValidStation(v: unknown): v is Station`; `readStation(dir?: string): Promise<Station | null>`; `writeStation(station: Station, dir?: string): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `src/server/station.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env --allow-read --allow-write src/server/station.test.ts`
Expected: FAIL — module `./station.ts` not found.

- [ ] **Step 3: Write the implementation**

Create `src/server/station.ts`:

```ts
// The operator's ground station, persisted next to recordings/ so pass
// predictions survive a restart.

import { appDataDir } from "./paths.ts";

export interface Station {
  lat: number;
  lon: number;
  /** Metres above sea level. Affects look angles only marginally, but SGP4
   * wants an observer height and 0 is a fine default. */
  altM: number;
  /** "auto" marks a fix from IP geolocation, which is city-accurate at
   * best. Any manual edit flips this to "manual" and stops auto-detect
   * from ever running unattended again. */
  source: "auto" | "manual";
}

function isFinite_(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function isValidStation(v: unknown): v is Station {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  if (!isFinite_(s.lat) || s.lat < -90 || s.lat > 90) return false;
  if (!isFinite_(s.lon) || s.lon < -180 || s.lon > 180) return false;
  if (!isFinite_(s.altM)) return false;
  return s.source === "auto" || s.source === "manual";
}

export async function readStation(dir: string = appDataDir()): Promise<Station | null> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(`${dir}/station.json`));
    // A file that fails validation degrades to "no station set" rather
    // than throwing: an unreadable config should not break the route on
    // every launch with no way back short of deleting it by hand.
    return isValidStation(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeStation(
  station: Station,
  dir: string = appDataDir(),
): Promise<void> {
  if (!isValidStation(station)) {
    throw new Error(`Invalid station: ${JSON.stringify(station)}`);
  }
  await Deno.mkdir(dir, { recursive: true });
  // Write-then-rename: a crash midway through a plain write would leave a
  // truncated file that readStation can only report as "unset", silently
  // losing a location the operator had already entered.
  const tmp = `${dir}/station.json.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(station));
  await Deno.rename(tmp, `${dir}/station.json`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env --allow-read --allow-write src/server/station.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/station.ts src/server/station.test.ts
git commit -m "feat: persist the ground station's coordinates"
```

---

### Task 4: Geolocation lookup and server functions

**Files:**
- Create: `src/server/geoip.ts`
- Modify: `src/server/functions.ts`
- Test: `src/server/geoip.test.ts`

**Interfaces:**
- Consumes: `Station`, `readStation`, `writeStation` (Task 3); `getTles`, `TleResult` (Task 2).
- Produces: `lookupCoordinates(fetchImpl?: typeof fetch): Promise<{ lat: number; lon: number }>`; server functions `getTleFn()`, `getStationFn()`, `setStationFn({ data: { lat, lon, altM } })`, `detectStationFn()`.

- [ ] **Step 1: Write the failing test**

Create `src/server/geoip.test.ts`:

```ts
import { assertEquals, assertRejects } from "@std/assert";

import { lookupCoordinates } from "./geoip.ts";

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    )) as unknown as typeof fetch;
}

Deno.test("lookupCoordinates reads latitude and longitude", async () => {
  const coords = await lookupCoordinates(
    jsonFetch({ success: true, latitude: 52.23, longitude: 21.01, city: "Warsaw" }),
  );
  assertEquals(coords, { lat: 52.23, lon: 21.01 });
});

Deno.test("lookupCoordinates rejects an unsuccessful lookup", async () => {
  await assertRejects(() =>
    lookupCoordinates(jsonFetch({ success: false, message: "rate limited" }))
  );
});

Deno.test("lookupCoordinates rejects an HTTP error", async () => {
  await assertRejects(() => lookupCoordinates(jsonFetch({}, 503)));
});

Deno.test("lookupCoordinates rejects out-of-range coordinates", async () => {
  await assertRejects(() =>
    lookupCoordinates(jsonFetch({ success: true, latitude: 999, longitude: 0 }))
  );
});

Deno.test("lookupCoordinates rejects a missing payload", async () => {
  await assertRejects(() => lookupCoordinates(jsonFetch({ success: true })));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env --allow-read --allow-write src/server/geoip.test.ts`
Expected: FAIL — module `./geoip.ts` not found.

- [ ] **Step 3: Write the geoip implementation**

Create `src/server/geoip.ts`:

```ts
// Approximate coordinates from the machine's public IP, used once to seed
// the ground station so a first run has something to predict passes
// against. City-accurate at best, and always editable afterwards.

const GEOIP_URL = "https://ipwho.is/";

interface IpWhoIsResponse {
  success?: boolean;
  message?: string;
  latitude?: number;
  longitude?: number;
}

export async function lookupCoordinates(
  fetchImpl: typeof fetch = fetch,
): Promise<{ lat: number; lon: number }> {
  const res = await fetchImpl(GEOIP_URL);
  if (!res.ok) throw new Error(`Geolocation lookup failed: HTTP ${res.status}`);

  const body = await res.json() as IpWhoIsResponse;
  // ipwho.is answers 200 with success:false for rate limits and reserved
  // addresses, so the status code alone does not mean a usable fix.
  if (body.success === false) {
    throw new Error(`Geolocation lookup failed: ${body.message ?? "unknown error"}`);
  }

  const { latitude: lat, longitude: lon } = body;
  if (
    typeof lat !== "number" || typeof lon !== "number" ||
    !Number.isFinite(lat) || !Number.isFinite(lon) ||
    lat < -90 || lat > 90 || lon < -180 || lon > 180
  ) {
    throw new Error("Geolocation lookup returned no usable coordinates");
  }
  return { lat, lon };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env --allow-read --allow-write src/server/geoip.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Add the server functions**

Append to `src/server/functions.ts` (and add the imports at the top of the file):

```ts
import { lookupCoordinates } from "./geoip.ts";
import { isValidStation, type Station, readStation, writeStation } from "./station.ts";
import { getTles, type TleResult } from "./tle.ts";
```

```ts
export const getTleFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<TleResult> => {
    return await getTles();
  },
);

export const getStationFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<Station | null> => {
    return await readStation();
  },
);

// The `{ lat, lon, altM }` annotation is erased at build time, so this
// validator is the request's first real runtime guard — it fails fast at
// the boundary rather than letting a malformed payload travel down to
// writeStation, which validates again before touching disk. Same
// belt-and-braces shape as deleteRecordingFn above.
export const setStationFn = createServerFn({ method: "POST" })
  .validator((data: { lat: number; lon: number; altM: number }): Station => {
    const station: Station = { ...data, source: "manual" };
    if (!isValidStation(station)) {
      throw new Error(`Invalid station: ${JSON.stringify(data)}`);
    }
    return station;
  })
  .handler(async ({ data }): Promise<Station> => {
    await writeStation(data);
    return data;
  });

// Runs only when getStationFn returned null, or when the operator presses
// Detect. Composes the two modules rather than letting geoip.ts touch disk.
export const detectStationFn = createServerFn({ method: "POST" }).handler(
  async (): Promise<Station> => {
    const { lat, lon } = await lookupCoordinates();
    const station: Station = { lat, lon, altM: 0, source: "auto" };
    await writeStation(station);
    return station;
  },
);
```

- [ ] **Step 6: Verify the whole suite and the type-check pass**

Run: `deno task test`
Expected: PASS — all existing tests plus the new ones.

Run: `npm run build`
Expected: builds and type-checks with no errors.

- [ ] **Step 7: Commit**

```bash
git add src/server/geoip.ts src/server/geoip.test.ts src/server/functions.ts
git commit -m "feat: add geolocation lookup and tracking server functions"
```

---

### Task 5: Orbit wrapper

**Files:**
- Create: `src/lib/orbit.ts`
- Test: `src/lib/orbit.test.ts`

**Interfaces:**
- Consumes: `satellite.js`.
- Produces: `interface Observer { lat: number; lon: number; altM: number }`; `interface Subpoint { lat: number; lon: number; altKm: number }`; `interface GeoPoint { lat: number; lon: number }`; `interface LookAngles { elevationDeg: number; azimuthDeg: number; rangeKm: number }`; `toSatrec(tle): SatRec | null`; `subpoint(satrec, date): Subpoint | null`; `lookAngles(satrec, observer, date): LookAngles | null`; `groundTrack(satrec, from, to, stepSec): GeoPoint[]`; `footprintRadiusDeg(altKm): number`.

**Note:** `src/server/station.ts`'s `Station` is structurally assignable to `Observer` (it has `lat`, `lon`, `altM` plus `source`), so a `Station` can be passed directly wherever an `Observer` is wanted. No conversion needed.

- [ ] **Step 1: Write the failing test**

Create `src/lib/orbit.test.ts`:

```ts
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

// A TLE whose argument-of-perigee field is non-numeric. This survives
// toSatrec's guard — sgp4init recomputes `no` and `jdsatepoch` from other
// fields, so both stay finite — but propagate then returns a NON-null
// result carrying {x: null, y: null, z: null}. Verified against the
// installed satellite.js@7.1.0. It is the narrowest input that reaches the
// NaN path, which is why it is used rather than wholesale garbage.
const N19_BAD_ARGP = {
  line1: N19.line1,
  line2: "2 33591  98.9503 278.5194 0012694 ABCDEFGH  80.6157 14.13479705900051",
};

Deno.test("lookAngles returns null rather than NaN angles", () => {
  const satrec = toSatrec(N19_BAD_ARGP);
  // Confirms the premise: this really does get past toSatrec.
  assert(satrec !== null, "fixture should survive toSatrec, or it tests nothing");
  assertEquals(lookAngles(satrec, { lat: 52.23, lon: 21.01, altM: 100 }, AT), null);
});

Deno.test("a NaN elevation would defeat both pass-bracketing comparisons", () => {
  // Guards the guard: this documents WHY lookAngles must return null
  // instead of NaN. passes.ts brackets a pass with these two comparisons,
  // and NaN makes both false, so the satellite would never appear to rise.
  const nan = Number.NaN;
  assertEquals(nan < 0, false);
  assertEquals(nan >= 0, false);
});

Deno.test("groundTrack drops unusable points without breaking the run", () => {
  const satrec = toSatrec(N19_BAD_ARGP);
  assert(satrec !== null);
  // Every sample is unusable for this fixture, so the track is empty
  // rather than an array of NaN coordinates.
  assertEquals(groundTrack(satrec, AT, new Date(AT.getTime() + 600_000), 60), []);
});

Deno.test("footprintRadiusDeg matches the geometry for a NOAA orbit", () => {
  // acos(6371 / (6371 + 868.9)) = 28.36 degrees.
  assert(Math.abs(footprintRadiusDeg(868.9) - 28.3595) < 0.001);
  // A higher orbit sees more of the planet.
  assert(footprintRadiusDeg(35786) > footprintRadiusDeg(868.9));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env --allow-read --allow-write src/lib/orbit.test.ts`
Expected: FAIL — module `./orbit.ts` not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/orbit.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env --allow-read --allow-write src/lib/orbit.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/orbit.ts src/lib/orbit.test.ts
git commit -m "feat: wrap satellite.js propagation in a degrees-based API"
```

---

### Task 6: Footprint geometry

**Files:**
- Create: `src/lib/footprint.ts`
- Test: `src/lib/footprint.test.ts`

**Interfaces:**
- Consumes: `GeoPoint` from `./orbit.ts`.
- Produces: `footprintPolygon(lat: number, lon: number, radiusDeg: number, steps?: number): GeoPoint[]`; `enclosedPole(lat: number, radiusDeg: number): "north" | "south" | null`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/footprint.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env --allow-read --allow-write src/lib/footprint.test.ts`
Expected: FAIL — module `./footprint.ts` not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/footprint.ts`:

```ts
// A satellite's footprint is a circle on the sphere, which equirectangular
// projection turns into a distorted oval — and NOAA's 98-degree inclination
// puts these satellites at high latitude often enough that the shape
// regularly wraps around a pole. Sampling the circle in spherical
// coordinates and projecting the samples is the only approach that stays
// correct there; a canvas arc() would look right near the equator and
// visibly wrong exactly when it matters.

import type { GeoPoint } from "./orbit.ts";

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env --allow-read --allow-write src/lib/footprint.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/footprint.ts src/lib/footprint.test.ts
git commit -m "feat: compute satellite footprint polygons on the sphere"
```

---

### Task 7: Equirectangular projection

**Files:**
- Create: `src/lib/projection.ts`
- Test: `src/lib/projection.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `project(lat: number, lon: number, width: number, height: number): { x: number; y: number }`; `splitAtAntimeridian<T extends { lon: number }>(points: T[]): T[][]`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/projection.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env --allow-read --allow-write src/lib/projection.test.ts`
Expected: FAIL — module `./projection.ts` not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/projection.ts`:

```ts
// Equirectangular projection: longitude maps linearly to x, latitude
// linearly to y. It distorts area badly near the poles, but it is the
// projection that makes a satellite's ground track read as the familiar
// sine wave, which is the whole point of the map.

export function project(
  lat: number,
  lon: number,
  width: number,
  height: number,
): { x: number; y: number } {
  return {
    x: ((lon + 180) / 360) * width,
    y: ((90 - lat) / 180) * height,
  };
}

/** Splits a path wherever consecutive points jump more than half the globe
 * in longitude — the signature of a wrap across the antimeridian.
 *
 * Without this, a track running from 179 to -179 draws as a line all the
 * way back across the map: one long horizontal streak through every
 * continent, which reads as a rendering bug rather than a wrap. */
export function splitAtAntimeridian<T extends { lon: number }>(points: T[]): T[][] {
  const segments: T[][] = [];
  let current: T[] = [];

  for (const point of points) {
    const previous = current.at(-1);
    if (previous && Math.abs(point.lon - previous.lon) > 180) {
      segments.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env --allow-read --allow-write src/lib/projection.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/projection.ts src/lib/projection.test.ts
git commit -m "feat: add equirectangular projection with antimeridian splitting"
```

---

### Task 8: Day/night terminator

**Files:**
- Create: `src/lib/terminator.ts`
- Test: `src/lib/terminator.test.ts`

**Interfaces:**
- Consumes: `satellite.js` (`jday`, `sunPos`, `gstime`, `radiansToDegrees`).
- Produces: `interface Subsolar { lat: number; lon: number }`; `subsolarPoint(date: Date): Subsolar`; `terminatorLatitude(lonDeg: number, sub: Subsolar): number`; `isNight(latDeg: number, lonDeg: number, sub: Subsolar): boolean`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/terminator.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env --allow-read --allow-write src/lib/terminator.test.ts`
Expected: FAIL — module `./terminator.ts` not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/terminator.ts`:

```ts
// Day/night shading. The subsolar point comes from satellite.js's own
// Vallado sun model rather than a hand-rolled solar position formula —
// it is already a dependency, and its accuracy (0.01 degrees, valid
// 1950-2050) is far beyond what a shaded map needs.

import { gstime, jday, radiansToDegrees, sunPos } from "satellite.js";

export interface Subsolar {
  lat: number;
  lon: number;
}

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Below this declination the terminator curve's tan() blows up. Clamping
 * costs a few kilometres of accuracy for the two days a year either side
 * of an equinox, and avoids a divide-by-zero that would blank the layer. */
const MIN_DECLINATION_DEG = 0.1;

/** Normalises degrees into [-180, 180]. */
function wrapLongitude(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/** The point on Earth with the sun directly overhead: its latitude is the
 * solar declination, and its longitude is the sun's right ascension
 * measured against the Greenwich meridian's current sidereal angle. */
export function subsolarPoint(date: Date): Subsolar {
  const { rtasc, decl } = sunPos(jday(date));
  return {
    lat: radiansToDegrees(decl),
    lon: wrapLongitude(radiansToDegrees(rtasc - gstime(date))),
  };
}

/** Latitude at which the terminator crosses a given meridian.
 *
 * Solving cos(angular distance to the sun) = 0 for latitude gives
 * tan(lat) = -cos(hour angle) / tan(declination). Expressing the curve per
 * column of the map means polar day and polar night need no special case:
 * the curve simply runs off the top or bottom edge. */
export function terminatorLatitude(lonDeg: number, sub: Subsolar): number {
  let declination = sub.lat;
  if (Math.abs(declination) < MIN_DECLINATION_DEG) {
    declination = declination >= 0 ? MIN_DECLINATION_DEG : -MIN_DECLINATION_DEG;
  }
  const hourAngle = toRad(lonDeg - sub.lon);
  return radiansToDegrees(
    Math.atan(-Math.cos(hourAngle) / Math.tan(toRad(declination))),
  );
}

/** True when the sun is below the horizon — that is, when the point is
 * more than 90 degrees of arc away from the subsolar point. */
export function isNight(latDeg: number, lonDeg: number, sub: Subsolar): boolean {
  const cosDistance = Math.sin(toRad(latDeg)) * Math.sin(toRad(sub.lat)) +
    Math.cos(toRad(latDeg)) * Math.cos(toRad(sub.lat)) *
      Math.cos(toRad(lonDeg - sub.lon));
  return cosDistance < 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env --allow-read --allow-write src/lib/terminator.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/terminator.ts src/lib/terminator.test.ts
git commit -m "feat: compute the day/night terminator"
```

---

### Task 9: Pass prediction

**Files:**
- Create: `src/lib/passes.ts`
- Test: `src/lib/passes.test.ts`

**Interfaces:**
- Consumes: `Observer`, `lookAngles` from `./orbit.ts`; `SatRec` from `satellite.js`.
- Produces: `interface Pass { satId: string; aos: Date; los: Date; maxElevationDeg: number; aosAzimuth: number; losAzimuth: number }`; `nextPasses(satId: string, satrec: SatRec, observer: Observer, from: Date, hours: number): Pass[]`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/passes.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env --allow-read --allow-write src/lib/passes.test.ts`
Expected: FAIL — module `./passes.ts` not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/passes.ts`:

```ts
// Pass prediction: when is a satellite above the horizon from here.
//
// There is no closed form for this, so it is a search: step elevation
// coarsely to bracket each horizon crossing, then bisect. The whole 24h
// search for three satellites measures around 10ms, which is cheap — but
// it is still pointless to repeat every second, so callers run it on
// station and element changes and a slow timer, never on the render tick.

import type { SatRec } from "satellite.js";

import { lookAngles, type Observer } from "./orbit.ts";

/** Coarse search step. A NOAA pass lasts 10-16 minutes, so 30s cannot step
 * over one entirely; the shortest pass a prototype produced was 4.5
 * minutes, still nine samples wide. */
const COARSE_STEP_MS = 30_000;

/** Bisection stops here: sub-second precision on an AOS that the element
 * set itself only pins down to within seconds would be false precision. */
const REFINE_PRECISION_MS = 1000;

/** Step for the peak-elevation scan within a bracketed pass. */
const PEAK_STEP_MS = 5000;

export interface Pass {
  satId: string;
  aos: Date;
  los: Date;
  maxElevationDeg: number;
  aosAzimuth: number;
  losAzimuth: number;
}

function elevationAt(satrec: SatRec, observer: Observer, ms: number): number {
  const look = lookAngles(satrec, observer, new Date(ms));
  // A propagation failure is treated as "not visible" so one bad sample
  // ends a bracket rather than throwing out of the whole search.
  return look ? look.elevationDeg : Number.NEGATIVE_INFINITY;
}

/** Narrows a bracketed horizon crossing to REFINE_PRECISION_MS. `rising`
 * selects which side of the crossing is below the horizon. */
function refineCrossing(
  satrec: SatRec,
  observer: Observer,
  loMs: number,
  hiMs: number,
  rising: boolean,
): number {
  let lo = loMs;
  let hi = hiMs;
  while (hi - lo > REFINE_PRECISION_MS) {
    const mid = (lo + hi) / 2;
    const belowHorizon = elevationAt(satrec, observer, mid) < 0;
    if (rising === belowHorizon) lo = mid;
    else hi = mid;
  }
  return hi;
}

export function nextPasses(
  satId: string,
  satrec: SatRec,
  observer: Observer,
  from: Date,
  hours: number,
): Pass[] {
  const start = from.getTime();
  const end = start + hours * 3600_000;
  const passes: Pass[] = [];

  let previousElevation = elevationAt(satrec, observer, start);
  let aosBracketMs: number | null = null;

  for (let ms = start + COARSE_STEP_MS; ms <= end; ms += COARSE_STEP_MS) {
    const elevation = elevationAt(satrec, observer, ms);

    if (previousElevation < 0 && elevation >= 0) aosBracketMs = ms;

    if (previousElevation >= 0 && elevation < 0 && aosBracketMs !== null) {
      const aosMs = refineCrossing(
        satrec,
        observer,
        aosBracketMs - COARSE_STEP_MS,
        aosBracketMs,
        true,
      );
      const losMs = refineCrossing(satrec, observer, ms - COARSE_STEP_MS, ms, false);

      let maxElevationDeg = 0;
      for (let t = aosMs; t <= losMs; t += PEAK_STEP_MS) {
        maxElevationDeg = Math.max(maxElevationDeg, elevationAt(satrec, observer, t));
      }

      const aosLook = lookAngles(satrec, observer, new Date(aosMs));
      const losLook = lookAngles(satrec, observer, new Date(losMs));

      passes.push({
        satId,
        aos: new Date(aosMs),
        los: new Date(losMs),
        maxElevationDeg,
        aosAzimuth: aosLook?.azimuthDeg ?? 0,
        losAzimuth: losLook?.azimuthDeg ?? 0,
      });
      aosBracketMs = null;
    }

    previousElevation = elevation;
  }

  // A pass still in progress at the end of the window is dropped rather
  // than reported with a fabricated LOS.
  return passes;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env --allow-read --allow-write src/lib/passes.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Run the whole suite**

Run: `deno task test`
Expected: PASS — every test, old and new.

- [ ] **Step 6: Commit**

```bash
git add src/lib/passes.ts src/lib/passes.test.ts
git commit -m "feat: predict satellite passes over the ground station"
```

---

### Task 10: Navigation shell and route skeleton

**Files:**
- Create: `src/lib/theme.ts`, `src/components/app-nav.tsx`, `src/routes/tracking.tsx`
- Modify: `src/routes/__root.tsx`, `src/routes/index.tsx`, `src/components/signal-panel.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `readToken(name: string, fallback: string): string` from `@/lib/theme`; `AppNav` component; the `/tracking` route.

**Note:** `src/components/signal-panel.tsx` already defines a private `readToken` with the SSR guard this app needs. Task 11's canvas needs the same helper, so it moves to `src/lib/theme.ts` and both files import it — rather than a second copy drifting from the first.

- [ ] **Step 1: Extract the theme token reader**

Create `src/lib/theme.ts`:

```ts
/** Reads a CSS custom property off the document root.
 *
 * Canvas has no access to Tailwind classes, so anything drawn there has to
 * resolve the theme's colours itself. The window guard matters because
 * this app server-renders: during SSR there is no document, and the
 * fallback stands in until hydration. */
export function readToken(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}
```

In `src/components/signal-panel.tsx`, delete the local `readToken` function and import it instead:

```ts
import { readToken } from "@/lib/theme";
```

- [ ] **Step 2: Create the nav bar**

Create `src/components/app-nav.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import { Map, Radio, Satellite } from "lucide-react";

const TABS = [
  { to: "/", label: "Capture", icon: Radio },
  { to: "/tracking", label: "Tracking", icon: Map },
] as const;

export function AppNav() {
  return (
    <nav className="flex shrink-0 items-center gap-6 border-b border-border bg-sidebar px-4 py-2">
      <div className="flex items-center gap-2">
        <Satellite className="size-4 text-signal" />
        <span className="font-mono text-sm tracking-[0.2em] uppercase">satelita</span>
      </div>

      <div className="flex items-center gap-1">
        {TABS.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="flex items-center gap-2 rounded-md px-3 py-1.5 font-mono text-xs tracking-wider uppercase text-muted-foreground transition-colors hover:text-foreground data-[status=active]:bg-accent data-[status=active]:text-accent-foreground"
          >
            <Icon className="size-3.5" />
            {label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
```

- [ ] **Step 3: Put the nav in the shell**

In `src/routes/__root.tsx`, import the nav and wrap `children`:

```tsx
import { AppNav } from "@/components/app-nav";
```

Replace the `<body>` contents:

```tsx
      <body className="flex h-screen flex-col overflow-hidden">
        <AppNav />
        {children}
        <Scripts />
      </body>
```

- [ ] **Step 4: Hand viewport height to the shell**

In `src/routes/index.tsx`, the `<main>` currently owns the viewport height; the shell does now. Change:

```tsx
    <main className="grid h-screen grid-cols-[17rem_1fr] overflow-hidden">
```

to:

```tsx
    <main className="grid min-h-0 flex-1 grid-cols-[17rem_1fr] overflow-hidden">
```

Then delete the now-duplicated wordmark block from the top of the `<aside>` — the nav owns it:

```tsx
        <div className="flex items-center gap-2">
          <Satellite className="size-4 text-signal" />
          <h1 className="font-mono text-sm tracking-[0.2em] uppercase">satelita</h1>
        </div>
```

Remove the now-unused `Satellite` import from `lucide-react` at the top of the same file.

- [ ] **Step 5: Create the route skeleton**

Create `src/routes/tracking.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/tracking")({
  component: Tracking,
});

function Tracking() {
  return (
    <main className="grid min-h-0 flex-1 grid-cols-[19rem_1fr] overflow-hidden">
      <aside className="flex min-h-0 flex-col gap-5 overflow-y-auto border-r border-border bg-sidebar p-4">
        <p className="font-mono text-xs text-muted-foreground">Station and passes</p>
      </aside>
      <section className="min-h-0 bg-background" />
    </main>
  );
}
```

- [ ] **Step 6: Verify in the browser**

Start the dev server with the `preview_start` tool (name `dev`, creating `.claude/launch.json` if absent with `runtimeExecutable: "npm"`, `runtimeArgs: ["run", "dev"]`, `port: 1420`).

Check: the nav renders on both routes; clicking Tracking shows the empty two-column layout; clicking Capture returns to the recorder with its rail intact and no leftover duplicate wordmark; the console is free of errors.

- [ ] **Step 7: Type-check and commit**

Run: `npm run build`
Expected: no type errors.

```bash
git add src/lib/theme.ts src/components/app-nav.tsx src/components/signal-panel.tsx src/routes/__root.tsx src/routes/index.tsx src/routes/tracking.tsx .claude/launch.json
git commit -m "feat: add top navigation and the tracking route shell"
```

---

### Task 11: World map base layers

**Files:**
- Create: `src/components/world-map.tsx`
- Modify: `src/routes/tracking.tsx`

**Interfaces:**
- Consumes: `project` (Task 7); `subsolarPoint`, `terminatorLatitude` (Task 8); `readToken` (Task 10).
- Produces: `interface WorldMapProps { date: Date; station: { lat: number; lon: number } | null; satellites: MapSatellite[] }` and `interface MapSatellite { id: string; label: string; color: string; subpoint: Subpoint; track: GeoPoint[] }` — `satellites` is accepted and ignored until Task 12.

- [ ] **Step 1: Write the component**

Create `src/components/world-map.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import landTopology from "world-atlas/land-110m.json";

import type { GeoPoint, Subpoint } from "@/lib/orbit";
import { project } from "@/lib/projection";
import { subsolarPoint, terminatorLatitude } from "@/lib/terminator";
import { readToken } from "@/lib/theme";

export interface MapSatellite {
  id: string;
  label: string;
  color: string;
  subpoint: Subpoint;
  track: GeoPoint[];
}

export interface WorldMapProps {
  date: Date;
  station: { lat: number; lon: number } | null;
  satellites: MapSatellite[];
}

/** Natural Earth's 110m land at 55KB, decoded once at module load. The
 * data stops at 85.6S, so Antarctica's lower edge is the dataset's edge
 * rather than a projection artefact. */
const LAND = feature(
  landTopology as unknown as Topology<{ land: GeometryCollection }>,
  (landTopology as unknown as Topology<{ land: GeometryCollection }>).objects.land,
);

/** Longitude sampling for the terminator curve. One point per two degrees
 * is smooth at any window size this app runs at. */
const TERMINATOR_STEP_DEG = 2;

/** Reprojecting Natural Earth's coastlines is by far the most expensive
 * thing this component does, and the result depends only on the canvas
 * size — not on the clock. Building it into a Path2D lets the 1 Hz redraw
 * be a single `ctx.fill(path)` instead of several thousand `lineTo` calls
 * a second, every second, for as long as the window is open. */
function buildLandPath(w: number, h: number): Path2D {
  const path = new Path2D();
  for (const f of LAND.features) {
    const geometry = f.geometry;
    if (geometry.type !== "MultiPolygon" && geometry.type !== "Polygon") continue;
    const polygons = geometry.type === "MultiPolygon"
      ? geometry.coordinates
      : [geometry.coordinates];
    for (const polygon of polygons) {
      for (const ring of polygon) {
        ring.forEach(([lon, lat], i) => {
          const { x, y } = project(lat, lon, w, h);
          if (i === 0) path.moveTo(x, y);
          else path.lineTo(x, y);
        });
        path.closePath();
      }
    }
  }
  return path;
}

function drawGraticule(ctx: CanvasRenderingContext2D, w: number, h: number, stroke: string) {
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let lon = -180; lon <= 180; lon += 30) {
    const { x } = project(0, lon, w, h);
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const { y } = project(lat, 0, w, h);
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
}

/** Shades the dark hemisphere by tracing the terminator across the map and
 * closing the path along whichever edge is in darkness — which is what
 * makes polar night fill correctly instead of leaving a gap at the pole. */
function drawNight(ctx: CanvasRenderingContext2D, w: number, h: number, date: Date, fill: string) {
  const sub = subsolarPoint(date);
  ctx.fillStyle = fill;
  ctx.beginPath();

  for (let lon = -180; lon <= 180; lon += TERMINATOR_STEP_DEG) {
    const { x, y } = project(terminatorLatitude(lon, sub), lon, w, h);
    if (lon === -180) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }

  // Northern-summer sun means the south is dark, and vice versa.
  const darkEdgeY = sub.lat >= 0 ? h : 0;
  ctx.lineTo(w, darkEdgeY);
  ctx.lineTo(0, darkEdgeY);
  ctx.closePath();
  ctx.fill();
}

function drawStation(ctx: CanvasRenderingContext2D, w: number, h: number, station: { lat: number; lon: number }, color: string) {
  const { x, y } = project(station.lat, station.lon, w, h);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x - 6, y);
  ctx.lineTo(x + 6, y);
  ctx.moveTo(x, y - 6);
  ctx.lineTo(x, y + 6);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 3.5, 0, 2 * Math.PI);
  ctx.stroke();
}

export function WorldMap({ date, station }: WorldMapProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  // The observer is set up once. Keeping it out of the drawing effect
  // matters because that effect reruns on every tick of the clock, which
  // would otherwise tear down and rebuild a ResizeObserver once a second
  // for the lifetime of the window.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => setSize({ w: wrap.clientWidth, h: wrap.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  // getComputedStyle forces a style resolution, so the palette is read
  // once rather than 86,400 times a day. The theme is fixed at runtime —
  // <html> is hard-coded to `dark` — so there is nothing to react to.
  const colors = useMemo(() => ({
    ocean: readToken("--background", "#0b0f14"),
    land: readToken("--muted", "#1d2430"),
    grid: readToken("--grid", "#243040"),
    night: "oklch(0 0 0 / 45%)",
    station: readToken("--signal", "#4ade80"),
  }), []);

  // Rebuilt only when the map is resized. React is explicitly allowed to
  // discard a useMemo cache, but the only cost here is rebuilding a path
  // that is already rebuilt on resize — no correctness risk, unlike the
  // canvas ref in routes/index.tsx where a discarded memo would wipe a
  // pass mid-capture.
  const landPath = useMemo(
    () => (size.w > 0 && size.h > 0 ? buildLandPath(size.w, size.h) : null),
    [size.w, size.h],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const { w, h } = size;
    if (!canvas || !landPath || w === 0 || h === 0) return;

    const dpr = window.devicePixelRatio || 1;
    // Assigning width/height clears the canvas, which is exactly what is
    // wanted at the top of a full redraw.
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = colors.ocean;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = colors.land;
    ctx.fill(landPath);
    drawGraticule(ctx, w, h, colors.grid);
    drawNight(ctx, w, h, date, colors.night);
    if (station) drawStation(ctx, w, h, station, colors.station);
  }, [date, station, size, landPath, colors]);

  return (
    <div ref={wrapRef} className="size-full min-h-0">
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}
```

- [ ] **Step 2: Mount it in the route**

In `src/routes/tracking.tsx`, replace the empty `<section>` and add a clock so the terminator advances:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { WorldMap } from "@/components/world-map";

export const Route = createFileRoute("/tracking")({
  component: Tracking,
});

function Tracking() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <main className="grid min-h-0 flex-1 grid-cols-[19rem_1fr] overflow-hidden">
      <aside className="flex min-h-0 flex-col gap-5 overflow-y-auto border-r border-border bg-sidebar p-4">
        <p className="font-mono text-xs text-muted-foreground">Station and passes</p>
      </aside>
      <section className="min-h-0 overflow-hidden">
        <WorldMap date={now} station={{ lat: 52.23, lon: 21.01 }} satellites={[]} />
      </section>
    </main>
  );
}
```

The hardcoded station is a placeholder that Task 15 replaces with the real one.

- [ ] **Step 3: Verify in the browser**

With the dev server running, open `/tracking` and confirm with a screenshot:
- Continents are visible and correctly shaped, filling the full width.
- The graticule shows 30-degree lines.
- Night shading covers a plausible half of the globe for the current UTC time, curving rather than running straight, and reaching the correct pole.
- The station crosshair sits over Poland.
- Resizing the window redraws at the new size with no blurring.
- The console is clean.

- [ ] **Step 4: Type-check and commit**

Run: `npm run build`
Expected: no type errors.

```bash
git add src/components/world-map.tsx src/routes/tracking.tsx
git commit -m "feat: draw the base world map with graticule and terminator"
```

---

### Task 12: Satellite layers on the map

**Files:**
- Modify: `src/components/world-map.tsx`

**Interfaces:**
- Consumes: `MapSatellite` (Task 11); `footprintPolygon`, `enclosedPole` (Task 6); `footprintRadiusDeg` (Task 5); `splitAtAntimeridian` (Task 7).
- Produces: no new exports — `WorldMap` now renders the `satellites` prop it already accepted.

- [ ] **Step 1: Add the satellite drawing functions**

In `src/components/world-map.tsx`, add two new imports and **widen the existing projection import** rather than adding a second one — Task 11 already imports `project` from that module:

```tsx
import { enclosedPole, footprintPolygon } from "@/lib/footprint";
import { footprintRadiusDeg } from "@/lib/orbit";
```

Change the existing line:

```tsx
import { project } from "@/lib/projection";
```

to:

```tsx
import { project, splitAtAntimeridian } from "@/lib/projection";
```

Note `footprintRadiusDeg` joins the existing type-only import from `@/lib/orbit`, which must become a value import: `import { footprintRadiusDeg } from "@/lib/orbit";` alongside `import type { GeoPoint, Subpoint } from "@/lib/orbit";`.

Add these functions above the `WorldMap` component:

```tsx
function strokePath(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  points: GeoPoint[],
) {
  // Every path on a wrapping map has to be split first, or a segment
  // crossing 180 draws as a streak straight back across the map.
  for (const segment of splitAtAntimeridian(points)) {
    ctx.beginPath();
    segment.forEach((p, i) => {
      const { x, y } = project(p.lat, p.lon, w, h);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

function drawTrack(ctx: CanvasRenderingContext2D, w: number, h: number, sat: MapSatellite) {
  ctx.strokeStyle = sat.color;
  ctx.lineWidth = 1.25;
  ctx.globalAlpha = 0.55;
  ctx.setLineDash([4, 3]);
  strokePath(ctx, w, h, sat.track);
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

function drawFootprint(ctx: CanvasRenderingContext2D, w: number, h: number, sat: MapSatellite) {
  const radius = footprintRadiusDeg(sat.subpoint.altKm);
  const polygon = footprintPolygon(sat.subpoint.lat, sat.subpoint.lon, radius);
  const pole = enclosedPole(sat.subpoint.lat, radius);

  ctx.strokeStyle = sat.color;
  ctx.fillStyle = sat.color;
  ctx.lineWidth = 1;

  if (pole === null) {
    // An ordinary footprint is a closed loop, so it can be filled.
    const segments = splitAtAntimeridian(polygon);
    for (const segment of segments) {
      ctx.beginPath();
      segment.forEach((p, i) => {
        const { x, y } = project(p.lat, p.lon, w, h);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.globalAlpha = 0.1;
      ctx.fill();
      ctx.globalAlpha = 0.7;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    return;
  }

  // A footprint containing a pole has no closed outline in this
  // projection: it enters at one edge and leaves at the other. Closing it
  // along the map's top or bottom edge fills the polar cap that the
  // satellite really does see.
  const sorted = [...polygon].sort((a, b) => a.lon - b.lon);
  const edgeY = pole === "north" ? 0 : h;
  ctx.beginPath();
  sorted.forEach((p, i) => {
    const { x, y } = project(p.lat, p.lon, w, h);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(w, edgeY);
  ctx.lineTo(0, edgeY);
  ctx.closePath();
  ctx.globalAlpha = 0.1;
  ctx.fill();
  ctx.globalAlpha = 0.7;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawMarker(ctx: CanvasRenderingContext2D, w: number, h: number, sat: MapSatellite) {
  const { x, y } = project(sat.subpoint.lat, sat.subpoint.lon, w, h);

  ctx.fillStyle = sat.color;
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, 2 * Math.PI);
  ctx.fill();

  ctx.font = "11px ui-monospace, monospace";
  ctx.textBaseline = "middle";
  // Flip the label to the left near the right edge so it never runs off.
  const labelWidth = ctx.measureText(sat.label).width;
  const flip = x + 10 + labelWidth > w;
  ctx.textAlign = flip ? "right" : "left";
  ctx.fillText(sat.label, flip ? x - 8 : x + 8, y);
}
```

- [ ] **Step 2: Call them from the render loop**

In `WorldMap`, add `satellites` back to the destructured props and to the effect's dependency array, then draw them after the station:

```tsx
export function WorldMap({ date, station, satellites }: WorldMapProps) {
```

At the end of the drawing `useEffect` — the one whose dependency array is
`[date, station, size, landPath, colors]` — immediately after the
`if (station) drawStation(...)` line:

```tsx
    for (const sat of satellites) drawTrack(ctx, w, h, sat);
    for (const sat of satellites) drawFootprint(ctx, w, h, sat);
    for (const sat of satellites) drawMarker(ctx, w, h, sat);
```

And add `satellites` to that effect's dependency array, keeping the rest:

```tsx
  }, [date, station, size, landPath, colors, satellites]);
```

Leave the setup effect (`[]`) and the two `useMemo` caches alone — they
exist so that resizing and theme reads do not happen on every tick, and
adding `satellites` to any of them would undo that.

- [ ] **Step 3: Feed the map real satellites temporarily**

In `src/routes/tracking.tsx`, add a temporary block so the layers can be seen before the hook exists. This is replaced wholesale in Task 15.

Widen the existing React import to `import { useEffect, useMemo, useState } from "react";` rather than adding a second one, then add:

```tsx
import { groundTrack, subpoint, toSatrec } from "@/lib/orbit";
import { readToken } from "@/lib/theme";

const DEMO_TLE = {
  line1: "1 33591U 09005A   26207.61995983  .00000042  00000+0  46283-4 0  9994",
  line2: "2 33591  98.9503 278.5194 0012694 279.3580  80.6157 14.13479705900051",
};
```

Inside `Tracking`, before the return:

```tsx
  const satellites = useMemo(() => {
    const satrec = toSatrec(DEMO_TLE);
    if (!satrec) return [];
    const sp = subpoint(satrec, now);
    if (!sp) return [];
    return [{
      id: "19",
      label: "NOAA-19",
      color: readToken("--chart-1", "#4ade80"),
      subpoint: sp,
      track: groundTrack(
        satrec,
        new Date(now.getTime() - 50 * 60_000),
        new Date(now.getTime() + 50 * 60_000),
        30,
      ),
    }];
  }, [now]);
```

And pass it: `<WorldMap date={now} station={{ lat: 52.23, lon: 21.01 }} satellites={satellites} />`

- [ ] **Step 4: Verify in the browser**

Open `/tracking` and confirm with a screenshot:
- A dashed sine-wave ground track spans the map with no horizontal streak across it.
- A translucent footprint circle surrounds the marker.
- Watch until the satellite reaches high latitude (or temporarily change `now` by an hour in the `useMemo` to force it): the footprint fills the polar cap rather than pinching to a point or vanishing.
- The `NOAA-19` label is readable and flips side near the right edge.
- The marker moves once per second.
- The console is clean.

- [ ] **Step 5: Type-check and commit**

Run: `npm run build`
Expected: no type errors.

```bash
git add src/components/world-map.tsx src/routes/tracking.tsx
git commit -m "feat: draw ground tracks, footprints and satellite markers"
```

---

### Task 13: Station settings panel

**Files:**
- Create: `src/components/station-settings.tsx`

**Interfaces:**
- Consumes: `Station` type from `@/server/station`; existing UI primitives in `@/components/ui/`.
- Produces: `interface StationSettingsProps { station: Station | null; detecting: boolean; saving: boolean; error: string | null; onSave: (values: { lat: number; lon: number; altM: number }) => void; onDetect: () => void }`; `StationSettings` component.

- [ ] **Step 1: Write the component**

Create `src/components/station-settings.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Crosshair } from "lucide-react";

import type { Station } from "@/server/station";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface StationSettingsProps {
  station: Station | null;
  detecting: boolean;
  saving: boolean;
  error: string | null;
  onSave: (values: { lat: number; lon: number; altM: number }) => void;
  onDetect: () => void;
}

function parseCoordinate(value: string, limit: number): number | null {
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n)) return null;
  return n >= -limit && n <= limit ? n : null;
}

export function StationSettings(
  { station, detecting, saving, error, onSave, onDetect }: StationSettingsProps,
) {
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [altM, setAltM] = useState("");

  // Re-seed the fields whenever a new station arrives — on first load, and
  // after Detect replaces the coordinates the operator is looking at.
  useEffect(() => {
    setLat(station ? String(station.lat) : "");
    setLon(station ? String(station.lon) : "");
    setAltM(station ? String(station.altM) : "");
  }, [station]);

  const parsedLat = parseCoordinate(lat, 90);
  const parsedLon = parseCoordinate(lon, 180);
  const parsedAlt = Number(altM.trim() === "" ? "0" : altM);
  const valid = parsedLat !== null && parsedLon !== null && Number.isFinite(parsedAlt);

  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-center justify-between">
        <h2 className="font-mono text-xs tracking-[0.2em] uppercase text-muted-foreground">
          Station
        </h2>
        {station && (
          <span className="font-mono text-[10px] uppercase text-muted-foreground">
            {station.source === "auto" ? "auto-detected" : "manual"}
          </span>
        )}
      </header>

      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="station-lat" className="font-mono text-[11px]">Latitude</Label>
          <Input
            id="station-lat"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            inputMode="decimal"
            aria-invalid={lat !== "" && parsedLat === null}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="station-lon" className="font-mono text-[11px]">Longitude</Label>
          <Input
            id="station-lon"
            value={lon}
            onChange={(e) => setLon(e.target.value)}
            inputMode="decimal"
            aria-invalid={lon !== "" && parsedLon === null}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="station-alt" className="font-mono text-[11px]">Altitude (m)</Label>
        <Input
          id="station-alt"
          value={altM}
          onChange={(e) => setAltM(e.target.value)}
          inputMode="decimal"
        />
      </div>

      {error && <p className="font-mono text-[11px] text-destructive">{error}</p>}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!valid || saving}
          onClick={() => onSave({ lat: parsedLat, lon: parsedLon, altM: parsedAlt })}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="secondary" disabled={detecting} onClick={onDetect}>
          <Crosshair className="size-3.5" />
          {detecting ? "Detecting…" : "Detect"}
        </Button>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Confirm the UI primitives match**

Read `src/components/ui/button.tsx`, `input.tsx` and `label.tsx` and confirm the `size`/`variant` prop values used above exist. If they differ, adjust the calls to match the real API rather than changing the primitives. Check `src/components/capture-panel.tsx` for how this codebase already composes these three.

- [ ] **Step 3: Type-check and commit**

Run: `npm run build`
Expected: no type errors.

```bash
git add src/components/station-settings.tsx
git commit -m "feat: add the ground station settings panel"
```

---

### Task 14: Pass list panel

**Files:**
- Create: `src/components/pass-list.tsx`

**Interfaces:**
- Consumes: `Pass` from `@/lib/passes`.
- Produces: `interface PassListProps { passes: Pass[]; now: Date; colors: Record<string, string>; labels: Record<string, string> }`; `PassList` component.

- [ ] **Step 1: Write the component**

Create `src/components/pass-list.tsx`:

```tsx
import type { Pass } from "@/lib/passes";

export interface PassListProps {
  passes: Pass[];
  now: Date;
  /** Satellite id -> CSS colour, shared with the map so a row and its
   * ground track are recognisably the same satellite. */
  colors: Record<string, string>;
  labels: Record<string, string>;
}

function formatClock(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `in ${hours}h ${minutes}m` : `in ${minutes}m`;
}

/** Northbound or southbound, from where the satellite rises and sets.
 * Which one it is decides whether the image runs up or down the strip. */
function direction(pass: Pass): string {
  const rising = pass.aosAzimuth > 180 ? 360 - pass.aosAzimuth : pass.aosAzimuth;
  const setting = pass.losAzimuth > 180 ? 360 - pass.losAzimuth : pass.losAzimuth;
  return rising > setting ? "S→N" : "N→S";
}

export function PassList({ passes, now, colors, labels }: PassListProps) {
  return (
    <section className="flex min-h-0 flex-col gap-3">
      <h2 className="font-mono text-xs tracking-[0.2em] uppercase text-muted-foreground">
        Upcoming passes
      </h2>

      {passes.length === 0
        ? (
          <p className="font-mono text-[11px] text-muted-foreground">
            No passes in the next 24 hours.
          </p>
        )
        : (
          <ul className="flex flex-col gap-1">
            {passes.map((pass) => {
              const inProgress = pass.aos <= now && now <= pass.los;
              return (
                <li
                  key={`${pass.satId}-${pass.aos.toISOString()}`}
                  className={`flex flex-col gap-1 rounded-md border px-2.5 py-2 ${
                    inProgress ? "border-signal bg-accent" : "border-border"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className="font-mono text-xs"
                      style={{ color: colors[pass.satId] }}
                    >
                      {labels[pass.satId] ?? pass.satId}
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {inProgress
                        ? "NOW"
                        : formatCountdown(pass.aos.getTime() - now.getTime())}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 font-mono text-[11px] text-muted-foreground">
                    <span>{formatClock(pass.aos)}–{formatClock(pass.los)}</span>
                    <span>
                      {Math.round(pass.maxElevationDeg)}° {direction(pass)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
    </section>
  );
}
```

- [ ] **Step 2: Type-check and commit**

Run: `npm run build`
Expected: no type errors.

```bash
git add src/components/pass-list.tsx
git commit -m "feat: add the upcoming passes panel"
```

---

### Task 15: Tracking hook and route assembly

**Files:**
- Create: `src/hooks/use-tracking.ts`
- Modify: `src/routes/tracking.tsx`, `README.md`

**Interfaces:**
- Consumes: every earlier task.
- Produces: `useTracking(station: Station | null)` returning `{ now: Date; satellites: MapSatellite[]; passes: Pass[]; colors: Record<string, string>; stale: boolean; fetchedAt: string | null; error: string | null; retry: () => void }`; plus `satelliteColors(): Record<string, string>` and `satelliteLabels: Record<string, string>`.

- [ ] **Step 1: Write the hook**

Create `src/hooks/use-tracking.ts`:

```ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SatRec } from "satellite.js";

import { getTleFn } from "@/server/functions";
import type { Station } from "@/server/station";
import type { TleResult } from "@/server/tle";
import type { MapSatellite } from "@/components/world-map";
import { groundTrack, subpoint, toSatrec } from "@/lib/orbit";
import { type Pass, nextPasses } from "@/lib/passes";
import { readToken } from "@/lib/theme";

/** Half a NOAA orbit either side of now: enough to see what is arriving
 * without the track wrapping the map into an unreadable tangle. */
const TRACK_HALF_WINDOW_MS = 50 * 60_000;
const TRACK_STEP_SEC = 30;

/** Markers move visibly every second; a track redrawn that often would be
 * recomputing 200 points to shift them by a pixel. */
const TRACK_REFRESH_MS = 30_000;

/** Pass prediction is ~10ms, so this cadence is about avoiding pointless
 * work rather than avoiding jank. */
const PASS_REFRESH_MS = 5 * 60_000;
const PASS_WINDOW_HOURS = 24;

const SAT_LABELS: Record<string, string> = {
  "15": "NOAA-15",
  "18": "NOAA-18",
  "19": "NOAA-19",
};

const SAT_COLOR_TOKENS: Record<string, string> = {
  "15": "--chart-1",
  "18": "--chart-2",
  "19": "--chart-3",
};

const SAT_COLOR_FALLBACKS: Record<string, string> = {
  "15": "#4ade80",
  "18": "#38bdf8",
  "19": "#fbbf24",
};

export function satelliteColors(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(SAT_COLOR_TOKENS).map(([id, token]) => [
      id,
      readToken(token, SAT_COLOR_FALLBACKS[id]),
    ]),
  );
}

export const satelliteLabels = SAT_LABELS;

export function useTracking(station: Station | null) {
  const [tles, setTles] = useState<TleResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [trackTick, setTrackTick] = useState(0);
  const [passTick, setPassTick] = useState(0);

  const loadTles = useCallback(() => {
    setError(null);
    void (async () => {
      try {
        setTles(await getTleFn());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  useEffect(loadTles, [loadTles]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTrackTick((t) => t + 1), TRACK_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setPassTick((t) => t + 1), PASS_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const satrecs = useMemo(() => {
    if (!tles) return {} as Record<string, SatRec>;
    const out: Record<string, SatRec> = {};
    for (const [id, tle] of Object.entries(tles.sats)) {
      const satrec = toSatrec(tle);
      // One unusable element set must not take the other satellites down.
      if (satrec) out[id] = satrec;
    }
    return out;
  }, [tles]);

  const colors = useMemo(() => satelliteColors(), []);

  // Tracks are keyed off trackTick, not `now`, so they recompute on their
  // own slower schedule. The ref keeps the tick effect from needing `now`
  // in its dependencies, which would defeat the whole arrangement.
  const nowRef = useRef(now);
  nowRef.current = now;

  const tracks = useMemo(() => {
    const at = nowRef.current;
    const out: Record<string, ReturnType<typeof groundTrack>> = {};
    for (const [id, satrec] of Object.entries(satrecs)) {
      out[id] = groundTrack(
        satrec,
        new Date(at.getTime() - TRACK_HALF_WINDOW_MS),
        new Date(at.getTime() + TRACK_HALF_WINDOW_MS),
        TRACK_STEP_SEC,
      );
    }
    return out;
    // Deliberately excludes `now`: the whole point is that tracks refresh
    // on trackTick's slower schedule, and listing `now` here would rebuild
    // them every second.
  }, [satrecs, trackTick]);

  const satellites = useMemo<MapSatellite[]>(() => {
    const out: MapSatellite[] = [];
    for (const [id, satrec] of Object.entries(satrecs)) {
      const sp = subpoint(satrec, now);
      if (!sp) continue;
      out.push({
        id,
        label: SAT_LABELS[id] ?? id,
        color: colors[id],
        subpoint: sp,
        track: tracks[id] ?? [],
      });
    }
    return out;
  }, [satrecs, now, tracks, colors]);

  const passes = useMemo<Pass[]>(() => {
    if (!station) return [];
    const at = nowRef.current;
    const all: Pass[] = [];
    for (const [id, satrec] of Object.entries(satrecs)) {
      all.push(...nextPasses(id, satrec, station, at, PASS_WINDOW_HOURS));
    }
    return all.sort((a, b) => a.aos.getTime() - b.aos.getTime());
    // Deliberately excludes `now` (read via nowRef): passes refresh on
    // passTick's 5-minute schedule, not once a second.
  }, [satrecs, station, passTick]);

  return {
    now,
    satellites,
    passes,
    colors,
    stale: tles?.stale ?? false,
    fetchedAt: tles?.fetchedAt ?? null,
    error,
    retry: loadTles,
  };
}
```

- [ ] **Step 2: Assemble the route**

Replace `src/routes/tracking.tsx` entirely:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { detectStationFn, getStationFn, setStationFn } from "@/server/functions";
import type { Station } from "@/server/station";
import { PassList } from "@/components/pass-list";
import { StationSettings } from "@/components/station-settings";
import { WorldMap } from "@/components/world-map";
import { satelliteLabels, useTracking } from "@/hooks/use-tracking";

export const Route = createFileRoute("/tracking")({
  component: Tracking,
});

/** Elements older than this drift enough to shift AOS by tens of seconds. */
const STALE_WARNING_DAYS = 7;

function Tracking() {
  const [station, setStation] = useState<Station | null>(null);
  const [stationError, setStationError] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [saving, setSaving] = useState(false);

  const { now, satellites, passes, colors, stale, fetchedAt, error, retry } = useTracking(
    station,
  );

  const detect = useCallback(async () => {
    setDetecting(true);
    setStationError(null);
    try {
      setStation(await detectStationFn());
    } catch (err) {
      setStationError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetecting(false);
    }
  }, []);

  // Auto-detect runs exactly once, and only when nothing was ever saved.
  // A failure here is reported but never blocks the map: manual entry is
  // always available, and the satellites do not depend on the station.
  useEffect(() => {
    void (async () => {
      try {
        const saved = await getStationFn();
        if (saved) {
          setStation(saved);
          return;
        }
        await detect();
      } catch (err) {
        setStationError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [detect]);

  const save = useCallback(async (values: { lat: number; lon: number; altM: number }) => {
    setSaving(true);
    setStationError(null);
    try {
      setStation(await setStationFn({ data: values }));
    } catch (err) {
      setStationError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, []);

  const elementsAgeDays = fetchedAt
    ? (now.getTime() - new Date(fetchedAt).getTime()) / 86_400_000
    : 0;

  return (
    <main className="grid min-h-0 flex-1 grid-cols-[19rem_1fr] overflow-hidden">
      <aside className="flex min-h-0 flex-col gap-5 overflow-y-auto border-r border-border bg-sidebar p-4">
        <StationSettings
          station={station}
          detecting={detecting}
          saving={saving}
          error={stationError}
          onSave={save}
          onDetect={detect}
        />

        {station
          ? (
            <PassList
              passes={passes}
              now={now}
              colors={colors}
              labels={satelliteLabels}
            />
          )
          : (
            <p className="font-mono text-[11px] text-muted-foreground">
              Set your location to see upcoming passes.
            </p>
          )}
      </aside>

      <section className="relative min-h-0 overflow-hidden">
        {(stale || elementsAgeDays > STALE_WARNING_DAYS) && (
          <div className="absolute top-2 left-2 z-10 rounded-md border border-border bg-popover px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
            {stale ? "Offline — using cached elements" : null}
            {!stale && `Elements are ${Math.floor(elementsAgeDays)} days old`}
          </div>
        )}

        {error && (
          <div className="absolute top-2 right-2 z-10 flex items-center gap-3 rounded-md border border-destructive bg-popover px-2.5 py-1 font-mono text-[11px] text-destructive">
            {error}
            <button type="button" className="underline" onClick={retry}>Retry</button>
          </div>
        )}

        <WorldMap date={now} station={station} satellites={satellites} />
      </section>
    </main>
  );
}
```

- [ ] **Step 3: Verify in the browser**

With the dev server running, open `/tracking` and confirm with a screenshot:
- All three satellites appear, in three distinct colours, each with a track and footprint.
- The pass list is populated, sorted by time, colours matching the map.
- The countdown ticks down.
- Editing latitude and pressing Save updates the station pin and repopulates the pass list.
- Pressing Detect either moves the pin or reports an error inline without blanking the map.

Then check the offline path: stop the network (or temporarily point `catalogUrl` at an unreachable host), delete `tle.json` from the app-data directory, reload, and confirm the base map and terminator still render with an error banner and a working Retry. Restore the URL afterwards.

- [ ] **Step 4: Run the whole suite and type-check**

Run: `deno task test`
Expected: PASS — every test.

Run: `npm run build`
Expected: builds and type-checks clean.

- [ ] **Step 5: Document the feature**

In `README.md`, add a `Tracking` bullet to the "Using the app" list, after the Image stage bullet:

```markdown
- **Tracking** — the `Tracking` tab shows where NOAA-15/18/19 are right
  now on an offline world map, with ground tracks, reception footprints and
  a day/night terminator. When your station pin falls inside a footprint,
  that satellite is above your horizon. The rail lists every pass over your
  location for the next 24 hours with its max elevation — passes below
  about 20° tend to be noisy and clipped by terrain. Set your coordinates
  in the **Station** panel; the first run tries to detect them from your IP
  address, and any manual edit takes precedence from then on. Orbital
  elements are fetched from Celestrak once a day and cached, so the map
  works offline.
```

- [ ] **Step 6: Commit**

```bash
git add src/hooks/use-tracking.ts src/routes/tracking.tsx README.md
git commit -m "feat: assemble the satellite tracking route"
```

---

## Self-Review Notes

**Spec coverage:** Every spec section maps to a task — TLE cache (1, 2), station (3), geoip (4), server functions (4), orbit/projection/terminator/passes (5–9), footprints including polar wrap (6, 12), nav and route (10), map layers (11, 12), pass list (14), station settings (13), failure modes (2, 3, 4, 15), README (15).

**Two deviations from the spec, both deliberate:**
1. The spec put `footprintPolygon` in `orbit.ts`. It is split into `src/lib/footprint.ts` because the polar-wrap logic is substantial enough to deserve its own file and test. `footprintRadiusDeg` stays in `orbit.ts` as specified.
2. `src/lib/theme.ts` and `src/hooks/use-tracking.ts` are not in the spec's file list. The first de-duplicates a helper that `signal-panel.tsx` already had and the canvas needs; the second keeps the three different refresh cadences out of the route component.

**Not unit-tested, by design:** every component and the hook. `deno test` has no DOM, and the existing suite covers `src/lib/` and `src/server/` only. Tasks 10, 11, 12 and 15 each carry an explicit browser verification step instead.
