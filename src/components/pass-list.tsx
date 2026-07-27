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
