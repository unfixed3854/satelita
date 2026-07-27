import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { WorldMap } from "@/components/world-map";
import { groundTrack, subpoint, toSatrec } from "@/lib/orbit";
import { readToken } from "@/lib/theme";

export const Route = createFileRoute("/tracking")({
  component: Tracking,
});

// Temporary: a single hardcoded NOAA-19 element set so the map layers are
// visible before Task 15 wires up the real TLE/pass-prediction hook. Task
// 15 replaces this file wholesale.
const DEMO_TLE = {
  line1: "1 33591U 09005A   26207.61995983  .00000042  00000+0  46283-4 0  9994",
  line2: "2 33591  98.9503 278.5194 0012694 279.3580  80.6157 14.13479705900051",
};

function Tracking() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

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

  return (
    <main className="grid min-h-0 flex-1 grid-cols-[19rem_1fr] overflow-hidden">
      <aside className="flex min-h-0 flex-col gap-5 overflow-y-auto border-r border-border bg-sidebar p-4">
        <p className="font-mono text-xs text-muted-foreground">Station and passes</p>
      </aside>
      <section className="min-h-0 overflow-hidden">
        <WorldMap date={now} station={{ lat: 52.23, lon: 21.01 }} satellites={satellites} />
      </section>
    </main>
  );
}
