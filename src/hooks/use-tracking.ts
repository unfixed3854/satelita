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

/** The instrument-token family, not shadcn's `--chart-*`. Only `--chart-1`
 * and `--chart-2` carry any chroma in this theme — 3, 4 and 5 are
 * achromatic greys, so a satellite assigned `--chart-3` renders in exactly
 * the grey of the land and ocean beneath it and cannot be picked out at
 * all. These three hues (green 148, amber 75, cyan 220) are the ones the
 * rest of the app already uses for live readouts. */
const SAT_COLOR_TOKENS: Record<string, string> = {
  "15": "--signal",
  "18": "--signal-warn",
  "19": "--signal-alt",
};

const SAT_COLOR_FALLBACKS: Record<string, string> = {
  "15": "#4ade80",
  "18": "#fbbf24",
  "19": "#38bdf8",
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
