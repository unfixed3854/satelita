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
