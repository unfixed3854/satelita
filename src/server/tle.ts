// Orbital element sets for the three APT satellites the app records,
// fetched from Celestrak and cached to disk so the tracking map works
// offline.

import { appDataDir } from "./paths.ts";

/** NORAD catalog number -> the short satellite id used throughout the app
 * (and by CapturePanel's SATS list). */
export const NOAA_CATALOG: Record<string, string> = {
  "25338": "15",
  "28654": "18",
  "33591": "19",
};

export interface TleSet {
  name: string;
  line1: string;
  line2: string;
}

const TLE_LINE_LENGTH = 69;

/** Sum of a TLE line's first 68 characters, digits at face value and
 * minus signs as 1 (everything else as 0), which the 69th character
 * records modulo 10. */
export function tleChecksum(line: string): number {
  let sum = 0;
  for (let i = 0; i < TLE_LINE_LENGTH - 1; i++) {
    const c = line[i];
    if (c >= "0" && c <= "9") sum += c.charCodeAt(0) - 48;
    else if (c === "-") sum += 1;
  }
  return sum % 10;
}

/** A truncated download, or a captive portal's HTML, yields lines that
 * *look* like elements and that SGP4 will happily propagate into a wrong
 * orbit with no error. The checksum is the only cheap defence, so nothing
 * is allowed to replace a good cache without passing it. */
export function isValidTleLine(line: string): boolean {
  if (line.length !== TLE_LINE_LENGTH) return false;
  const last = line[TLE_LINE_LENGTH - 1];
  if (last < "0" || last > "9") return false;
  return tleChecksum(line) === last.charCodeAt(0) - 48;
}

/** Parses Celestrak's 3-line-per-satellite TLE format, keeping only the
 * NOAA_CATALOG satellites whose element sets pass validation. */
export function parseTleText(text: string): Record<string, TleSet> {
  const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0);
  const out: Record<string, TleSet> = {};

  for (let i = 0; i + 2 < lines.length; i++) {
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (!line1?.startsWith("1 ") || !line2?.startsWith("2 ")) continue;

    const satId = NOAA_CATALOG[line1.slice(2, 7).trim()];
    if (!satId) continue;
    if (!isValidTleLine(line1) || !isValidTleLine(line2)) continue;

    out[satId] = { name: lines[i].trim(), line1, line2 };
  }
  return out;
}

/** Celestrak has no group containing NOAA-15/18/19 — its "weather" group
 * carries only the newer JPSS birds (NOAA 20/21), and there is no "noaa"
 * group at all. So these are fetched one CATNR at a time: three small
 * requests a day, which the 24h cache keeps well inside Celestrak's
 * usage guidance. */
function catalogUrl(catalogNumber: string): string {
  return `https://celestrak.org/NORAD/elements/gp.php?CATNR=${catalogNumber}&FORMAT=tle`;
}

/** Celestrak asks clients not to poll aggressively, and element sets are
 * only reissued a few times a day. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface TleCache {
  fetchedAt: string;
  sats: Record<string, TleSet>;
}

export interface TleResult {
  sats: Record<string, TleSet>;
  fetchedAt: string;
  /** True when these elements came from a cache that could not be
   * refreshed — the map still works, but the UI warns. */
  stale: boolean;
}

export interface GetTlesOptions {
  fetchImpl?: typeof fetch;
  dir?: string;
  now?: Date;
}

async function readCache(dir: string): Promise<TleCache | null> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(`${dir}/tle.json`)) as TleCache;
    if (typeof parsed?.fetchedAt !== "string") return null;
    if (typeof parsed?.sats !== "object" || parsed.sats === null || Array.isArray(parsed.sats)) {
      return null;
    }
    if (Object.keys(parsed.sats).length === 0) return null;
    return parsed;
  } catch {
    // Missing or unparseable: both mean "no usable cache", and a refetch
    // is the recovery for either.
    return null;
  }
}

async function writeCache(dir: string, cache: TleCache): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  const tmp = `${dir}/tle.json.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(cache));
  await Deno.rename(tmp, `${dir}/tle.json`);
}

export async function getTles(opts: GetTlesOptions = {}): Promise<TleResult> {
  const dir = opts.dir ?? appDataDir();
  const now = opts.now ?? new Date();
  const fetchImpl = opts.fetchImpl ?? fetch;

  const cache = await readCache(dir);
  const fresh = cache !== null &&
    now.getTime() - new Date(cache.fetchedAt).getTime() < CACHE_TTL_MS;
  if (cache && fresh) {
    return { sats: cache.sats, fetchedAt: cache.fetchedAt, stale: false };
  }

  try {
    // Per-satellite results are merged, and one satellite failing is
    // survivable: Celestrak occasionally has no current elements for a
    // given bird, and losing all three over one 404 would be worse than
    // drawing the two that did arrive.
    const results = await Promise.all(
      Object.keys(NOAA_CATALOG).map(async (catalogNumber) => {
        try {
          const res = await fetchImpl(catalogUrl(catalogNumber));
          if (!res.ok) return {};
          // An unparseable body is not a TLE feed at all — Celestrak's
          // "No GP data found", a captive portal, an error page. Treated
          // exactly like a failed request.
          return parseTleText(await res.text());
        } catch {
          return {};
        }
      }),
    );

    const fresh = Object.assign({}, ...results) as Record<string, TleSet>;
    if (Object.keys(fresh).length === 0) throw new Error("No usable element sets in response");

    // Fresh results are merged OVER the cache read above (not used in place
    // of it), so a satellite whose fetch failed this round keeps its
    // last-known-good elements instead of being evicted from the file. If a
    // satellite has neither a fresh result nor a prior cache entry it is
    // simply absent, exactly as before.
    const sats = Object.assign({}, cache?.sats ?? {}, fresh) as Record<string, TleSet>;

    // A satellite is only "stale" when its entry in `sats` came from the
    // cache rather than this round's fetch — that is the case the banner
    // needs to warn about, as distinct from a satellite that is simply
    // absent because it has never been cached.
    const staleFromCache = Object.values(NOAA_CATALOG).some(
      (satId) => !(satId in fresh) && satId in sats,
    );

    const updated: TleCache = { fetchedAt: now.toISOString(), sats };
    await writeCache(dir, updated);
    return { sats, fetchedAt: updated.fetchedAt, stale: staleFromCache };
  } catch (err) {
    if (cache) return { sats: cache.sats, fetchedAt: cache.fetchedAt, stale: true };
    throw err;
  }
}
