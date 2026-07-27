// Orbital element sets for the three APT satellites the app records,
// fetched from Celestrak and cached to disk so the tracking map works
// offline.

/** NORAD catalog number -> the short satellite id used throughout the app
 * (and by CapturePanel's SATS list). Celestrak's "noaa" group carries far
 * more than these three; everything else is discarded on parse. */
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
