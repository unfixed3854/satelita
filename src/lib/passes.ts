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

/** How far before `from` the coarse scan starts. A satellite can already be
 * above the horizon at `from` — mid-pass — and the crossing-based loop below
 * only records a pass when it *sees* the upward crossing, so without this
 * lookback that in-progress pass would have no AOS bracket and would be
 * silently dropped when it set. Starting the scan earlier lets the normal
 * crossing logic find its true AOS instead. 20 minutes comfortably exceeds
 * the ~16 minute maximum NOAA pass, so any pass live at `from` is guaranteed
 * to have risen within the lookback window. */
const PASS_LOOKBACK_MS = 20 * 60_000;

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
  const scanStart = start - PASS_LOOKBACK_MS;
  const passes: Pass[] = [];

  let previousElevation = elevationAt(satrec, observer, scanStart);
  let aosBracketMs: number | null = null;

  for (let ms = scanStart + COARSE_STEP_MS; ms <= end; ms += COARSE_STEP_MS) {
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
  // than reported with a fabricated LOS. A pass that already ended before
  // `from` (found only because the scan looks back before `from` to catch
  // one in progress) is dropped too — it is history, not upcoming.
  return passes.filter((p) => p.los.getTime() >= start);
}
