# Satellite tracking — deferred follow-ups

Items found during review of the tracking-map feature (spec:
`docs/superpowers/specs/2026-07-27-satellite-tracking-map-design.md`, plan:
`docs/superpowers/plans/2026-07-27-satellite-tracking-map.md`) that were
deliberately not fixed at the time. None blocks the feature — it ships with
104 passing tests, a clean build, and end-to-end verification against live
Celestrak data. They are recorded here so they are decisions rather than
oversights.

Line numbers were accurate at the time of writing; search by symbol if they
have drifted.

## Worth fixing

### 1. A 304 KB WASM chunk ships but is never fetched

`vite.config.ts`, `src/lib/terminator.ts`

`satellite.js`'s barrel re-exports an Emscripten pthreads WASM runtime.
Importing anything from the package pulls it into the module graph, so the
build emits a ~304 KB chunk. Tree-shaking keeps it out of the code path —
verified that no other chunk imports it and it is never requested at runtime
— but it still lands in the packaged desktop app.

It also forced `worker: { format: "es" }` into `vite.config.ts`: the WASM
runtime spawns a Worker using top-level await, which Vite's default `iife`
worker format cannot express, and the build fails without it.

The package publishes only a `"."` export, so deep-importing the pure-JS
modules to dodge the barrel is not possible without patching. Options: leave
it, patch the dependency, or hand-roll the two functions actually used
(`sunPos` and `gstime` for the subsolar point) and drop the client-side
dependency entirely.

### 2. A pass under a minute away reads "in 0m"

`src/components/pass-list.tsx:16` — `formatCountdown`

Floors to whole minutes, so a pass 30–59 seconds out displays `in 0m`. This
lands on the app's core workflow: the pass list exists to tell an operator
when to start recording, and the last minute before AOS is exactly when the
readout matters most. Showing seconds below one minute would fix it.

### 3. NOAA-18 is tracked but can no longer be recorded

`src/components/capture-panel.tsx:20`, `src/hooks/use-tracking.ts:26`

NOAA-18 was decommissioned in mid-2025. Celestrak still publishes current
elements, so it propagates and draws correctly on the map — but it no longer
transmits APT, so the capture side cannot record it. The tracking feature
did not introduce this; the satellite was already in `SATS`.

Deciding what to do is a product call: drop it, or mark it inactive in both
the capture selector and the tracking labels so the map explains why a
satellite with good passes yields nothing.

## Acceptable to defer

### 4. `footprintPolygon` degenerates at exactly ±90° latitude

`src/lib/footprint.ts:30-33`

The destination-point formula hits a 0/0 in `atan2` when the subpoint is
exactly on a pole, producing degenerate longitudes and a spurious >180° gap
after sorting. Unreachable for the satellites this app tracks: at 98.95°
inclination the subpoint latitude peaks near 81°. Worth a guard only if
non-polar-orbit satellites are ever added.

### 5. Station settings re-serialises the operator's typed text

`src/components/station-settings.tsx:33`

The effect that re-seeds the inputs from the `station` prop also fires after
a successful save, so `12.3400` comes back as `12.34`. Correct, mildly
surprising to watch.

### 6. `readCache`'s shape guard would accept a JSON array

`src/server/tle.ts:103`

`typeof parsed?.sats !== "object"` passes for an array. Not reachable —
`writeCache` is the only writer and always writes the right shape — but
`Array.isArray` would close it.

### 7. `maxElevationDeg` is seeded at 0 rather than -90

`src/lib/passes.ts:90`

Theoretically fragile for a vanishingly brief grazing pass whose sampled
peak never exceeds zero. Does not manifest at real NOAA pass durations
(3.8–15.8 minutes observed), and the existing `> 0` assertion would catch
it.

### 8. Split `@std/assert` import

`src/server/tle.test.ts:1` and `:68`

Two import statements from the same module, an artefact of the file being
written across two tasks. Cosmetic.

## Test-coverage gaps

### 9. No test for a 69-character TLE line ending in a non-digit

`src/server/tle.ts` — `isValidTleLine` rejects it via an explicit branch, but
nothing exercises that branch.

### 10. `enclosedPole`'s exact boundary is untested

`src/lib/footprint.test.ts:51`

The tests cover 61° and 62° with a 28.36° radius (89.36° and 90.36°), so the
exact `lat + radius === 90` case — where the implementation returns `null`,
treating "touches" as "does not enclose" — is never asserted.
