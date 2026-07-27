# Satellite tracking map — design

**Date:** 2026-07-27
**Status:** approved

## Problem

satelita records NOAA APT passes but gives no indication of where the
satellites are. Deciding when to press Record means consulting a separate
tracker. This adds a tracking view: a live world map showing NOAA-15/18/19,
and a list of upcoming passes over the operator's location.

## Scope

In scope:

- Live positions of NOAA-15, NOAA-18 and NOAA-19 on an offline world map.
- Ground tracks, footprint circles, and a day/night terminator.
- Ground-station coordinates, auto-detected on first run and editable.
- A 24-hour list of upcoming passes with AOS, LOS, duration, max elevation
  and direction.

Out of scope:

- A next-pass indicator on the capture page.
- Auto-starting a recording at AOS.
- Map zoom and pan; click-to-set-station.
- Satellites other than the three the app can record.
- Ground-track overlay on past recordings.

## Architecture

Orbital position is a pure function of `(elements, time)`, so propagation
runs in the browser. The server does only what the browser cannot: disk
caching, config persistence, and the one outward network call.

| Concern | Location |
| --- | --- |
| Fetch and disk-cache TLEs | `src/server/tle.ts` |
| Station persistence | `src/server/station.ts` |
| IP geolocation | `src/server/geoip.ts` |
| Propagation, projection, passes, terminator | `src/lib/` |
| Canvas rendering | `src/components/world-map.tsx` |

New files:

```
src/server/       tle.ts  station.ts  geoip.ts            (+ .test.ts each)
src/lib/          orbit.ts  passes.ts  projection.ts  terminator.ts
                                                          (+ .test.ts each)
src/components/   world-map.tsx  pass-list.tsx  station-settings.tsx
src/routes/       tracking.tsx
```

`deno task test` already globs `src/lib/` and `src/server/`, so the new
tests run with no configuration change.

Following the existing pattern, the four new server functions —
`getTleFn`, `getStationFn`, `setStationFn` and `detectStationFn` — are
declared in `src/server/functions.ts` alongside the recorder and recordings
functions, not in the modules themselves. Those modules stay plain,
directly-testable TypeScript.

New dependencies:

- `satellite.js@^7.1.0` — SGP4/SDP4 propagation.
- `world-atlas@^2.0.2` — Natural Earth coastlines as TopoJSON (data only).
- `topojson-client@^3.1.0` — TopoJSON to GeoJSON.

## Data layer

### TLEs — `src/server/tle.ts`

Source: `https://celestrak.org/NORAD/elements/gp.php?GROUP=noaa&FORMAT=tle`,
filtered to catalog numbers 25338 (NOAA-15), 28654 (NOAA-18) and 33591
(NOAA-19), so the cache holds only the satellites the app records.

Cache at `${appDataDir()}/tle.json`:

```json
{
  "fetchedAt": "2026-07-27T09:00:00.000Z",
  "sats": {
    "15": { "name": "NOAA 15", "line1": "1 25338U…", "line2": "2 25338…" }
  }
}
```

`getTleFn()` resolves in this order:

1. Cache present and younger than 24 hours — return it without a network
   call.
2. Otherwise fetch. On success, validate, write, and return.
3. Fetch failed but a cache exists — return the cache with `stale: true`.
4. Fetch failed and no cache exists — throw.

Element sets are validated before they may replace a good cache: two lines
of 69 characters each, whose mod-10 checksum digit matches. A truncated or
intercepted response otherwise yields a plausible pair of lines that SGP4
propagates into a wrong orbit, with no visible error.

`getTleFn()` always returns `{ sats, fetchedAt, stale }`. `stale` is true
when the elements came from a cache that could not be refreshed. The UI
derives element age from `fetchedAt` and warns past seven days: SGP4 drift by
then is enough to shift AOS by tens of seconds.

### Station — `src/server/station.ts`

`${appDataDir()}/station.json`:

```json
{ "lat": 52.23, "lon": 21.01, "altM": 100, "source": "auto" }
```

`source` is `"auto"` or `"manual"`. Written to a temporary file and renamed,
so a crash mid-write cannot leave an unparseable file that breaks the route
on every subsequent launch. Latitude and longitude are range-checked on both
read and write; a file that fails validation is treated as "no station set"
rather than throwing.

### Geolocation — `src/server/geoip.ts`

`geoip.ts` exposes a single `lookupCoordinates(fetch)` that issues one HTTPS
GET to `https://ipwho.is/`, which needs no API key, and returns
`{ lat, lon }`. It performs no disk I/O. The `detectStationFn` server
function composes the two modules: it calls `lookupCoordinates`, then hands
the result to `station.ts` to persist with `source: "auto"`.

Auto-detect runs unattended only when `getStationFn()` returns null — that is, on first run or
after the file is deleted. Any manual edit sets `source: "manual"`, after
which auto-detect never runs unattended again; the Detect button remains
available for explicit re-detection.

The service sees the machine's IP address and returns city-level accuracy.

### Testability

Both server modules take `fetch` and their base directory as injectable
parameters, so tests exercise cache-hit, cache-stale-network-ok,
cache-stale-network-fail, no-cache-network-fail and corrupt-file paths
without touching the network or the real app-data directory.

## Client math — `src/lib/`

Four pure modules with no I/O.

### `orbit.ts`

Wraps satellite.js so nothing else in the app touches its API:

- `subpoint(satrec, date)` → `{ lat, lon, altKm }`
- `lookAngles(satrec, station, date)` → `{ elevationDeg, azimuthDeg, rangeKm }`
- `groundTrack(satrec, from, to, stepSec)` → array of subpoints
- `footprintRadiusDeg(altKm)` = `acos(Rₑ / (Rₑ + h))`, about 28° at NOAA's
  ~850 km altitude

### `projection.ts`

Equirectangular `lat/lon → x/y` against a canvas of given width and height,
plus `splitAtAntimeridian(points)`. Without the split, a ground track
crossing 180° draws as a horizontal streak across the entire map.

### Footprints

A circle on the sphere is not a circle in equirectangular projection, and
because NOAA satellites are near-polar (98° inclination) they regularly sit
at high latitude, where the footprint wraps around the pole.

Footprints are therefore drawn by sampling roughly 90 points at even
bearings around the subpoint using the destination-point formula, projecting
each, and splitting at the antimeridian. When
`|subpointLat| + radiusDeg > 90°` the footprint encloses a pole, and the
path is closed along the top or bottom map edge to fill the polar cap.

A `ctx.arc()` would look correct near the equator and visibly wrong exactly
when it matters.

### `terminator.ts`

Solves for the terminator latitude per map column:

```
tan(lat) = −cos(lon − lon☉) / tan(lat☉)
```

filling toward whichever pole is in darkness. This handles polar day and
polar night without special cases, but degenerates to a vertical line at the
equinoxes as `lat☉ → 0`, so the subsolar latitude is clamped to a small
epsilon.

### `passes.ts`

`nextPasses(satrec, station, from, hours)` coarse-steps elevation at 30
seconds, brackets each upward zero crossing, bisects to 1 second for AOS and
LOS, and scans for peak elevation. Returns
`{ satId, aos, los, maxElevationDeg, aosAzimuth, losAzimuth }`.

There is no minimum-elevation filter. Every pass above the horizon is listed
with its max elevation shown, so the operator judges whether a grazing pass
is worth recording instead of a hardcoded threshold deciding for them.

Cost is roughly 8,600 propagations for three satellites over 24 hours,
measured at about 10 ms with satellite.js 7. That is cheap enough that the
scheduling choice is about avoiding pointless work rather than avoiding jank:
**pass prediction runs on station change, TLE change, and a 5-minute timer,
never on the 1 Hz render tick**, which performs only three `subpoint` calls.

## UI

### Navigation

A slim top bar moves into `src/routes/__root.tsx`'s shell so both routes
share it: the `satelita` wordmark on the left, relocated out of the capture
rail which currently owns it, and two tabs — Capture (`/`) and Tracking
(`/tracking`).

Knock-on edit: `src/routes/index.tsx`'s `<main>` drops `h-screen` for
`flex-1 min-h-0`, since the shell now owns viewport height.

### `/tracking` layout

Mirrors the capture page rather than inventing a new idiom: a left rail
holding Station and Upcoming passes, with the map filling the rest.

### `world-map.tsx`

A `<canvas>` resized via `ResizeObserver` and scaled for
`devicePixelRatio`. Coastlines come from `world-atlas/land-110m.json`,
decoded once at module load through `topojson-client` and cached as a
`Path2D`.

Canvas cannot read Tailwind classes, so the component reads theme tokens
once via `getComputedStyle(document.documentElement)` and paints with those
values, rather than hardcoding a second palette that would drift from the
app's.

Draw order:

1. Ocean background
2. Land
3. 30° graticule in `--grid` — an equirectangular map is hard to read
   without one
4. Night shading
5. Ground tracks
6. Footprints
7. Satellite markers and labels
8. Station pin

Each satellite gets a fixed colour from `--chart-1/2/3`, used consistently
across its marker, track, footprint and pass-list row. Which sine wave
belongs to which satellite is then answerable at a glance, with no selection
or hover mechanic needed.

Redraw runs at 1 Hz. Within that, ground tracks recompute every 30 seconds
and the terminator every 60 — both change far slower than the markers, and
recomputing 1,200 track points every second to move them one pixel is wasted
work.

### `pass-list.tsx`

All passes across the three satellites for the next 24 hours, merged and
sorted by AOS. Each row shows the satellite name in its colour, local start
time with a live countdown, duration, max elevation, and direction
(northbound or southbound, derived from the AOS and LOS azimuths). A pass in
progress pins to the top, highlighted.

### `station-settings.tsx`

Latitude, longitude and altitude inputs with Save; a Detect button to re-run
IP geolocation on demand; and a line showing whether the current fix came
from auto-detect or manual entry.

## Failure modes

Each data source failing degrades one layer, not the page.

| Failure | Result |
| --- | --- |
| No station set | Map draws normally without the station pin. Pass list becomes "Set your location" plus Detect. Auto-detect fires once here. |
| Auto-detect fails | Inline message; manual entry still works. The map is never blocked. |
| TLE cache stale, network down | Map fully functional from cache, with a stale-elements warning. |
| No cache and no network | Base map, graticule and terminator still render — neither needs a TLE. Error banner with Retry over the satellite layer. |
| `station.json` corrupt | Read as unset rather than throwing. |
| Celestrak drops a satellite | The others draw; the missing one is listed as unavailable. |
| Invalid manual coordinates | Inline validation; Save disabled. |

## Testing

Written test-first, following the project's existing practice.

- `orbit.test.ts` — propagation checked against the standard SGP4
  verification element set, rather than expected values invented for the
  test.
- `projection.test.ts` — round-trip, plus antimeridian splitting for tracks
  that cross, do not cross, and land exactly on 180°.
- `terminator.test.ts` — known day/night facts at fixed dates, including a
  polar-night case.
- `passes.test.ts` — fixed TLE, station and date: AOS < peak < LOS,
  elevation near zero at both horizon crossings, and a plausible pass count
  for a polar orbiter over 24 hours. A prototype of this search against real
  NOAA-19 elements from a mid-latitude station found 9 passes, so the test
  asserts a 5–12 band rather than an exact count.
- `tle.test.ts`, `station.test.ts`, `geoip.test.ts` — injected `fetch` and
  temporary directories covering every row of the failure-modes table, plus
  checksum rejection of a corrupted element set.

Canvas rendering is not unit-tested, as `deno test` has no DOM. It is
verified in the browser preview: all four layers drawing, a clean console,
and a screenshot.

## Known limitations

Pass times are only as accurate as the system clock, since everything
derives from `Date.now()`. Clock-skew detection is deliberately not
included.
