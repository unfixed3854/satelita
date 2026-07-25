// APT frame geometry and shared display formatters.
//
// A NOAA APT line is 2080 px: two identical 1040 px channel frames, each
// laid out [sync 39 | space 47 | video 909 | telemetry 45]. Channel A
// carries a visible/near-IR band, channel B a thermal-IR band.

export const APT_LINE_WIDTH = 2080;

/** Horizontal extent of each channel as a fraction of the full line.
 * Fractions rather than pixel offsets so the crop stays correct whatever
 * width the source canvas or image happens to be. */
export const CHANNEL_FRACTIONS = {
  both: { start: 0, width: 1 },
  a: { start: 0, width: 0.5 },
  b: { start: 0.5, width: 0.5 },
} as const;

export type ChannelMode = keyof typeof CHANNEL_FRACTIONS;

export function fmtElapsed(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 100 ? v.toFixed(1) : String(Math.round(v))} ${units[i]}`;
}

export function fmtClock(epochSecs: number): string {
  return new Date(epochSecs * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
