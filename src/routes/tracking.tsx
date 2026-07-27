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
