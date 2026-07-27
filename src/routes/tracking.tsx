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
