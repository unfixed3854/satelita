import { assertEquals } from "@std/assert";

import { isValidTleLine, parseTleText, tleChecksum } from "./tle.ts";

// Real element sets fetched from Celestrak (epoch 26207). Every line here
// carries its genuine checksum digit — do not retype or "tidy" them, and do
// not adjust the expected values below to make a failing test pass. If these
// ever fail, the implementation is wrong, not the data.
const N19_L1 = "1 33591U 09005A   26207.61995983  .00000042  00000+0  46283-4 0  9994";
const N19_L2 = "2 33591  98.9503 278.5194 0012694 279.3580  80.6157 14.13479705900051";
const N15_L1 = "1 25338U 98030A   26207.58735544  .00000131  00000+0  71180-4 0  9994";
const N15_L2 = "2 25338  98.5066 227.1548 0009309 227.3169 132.7228 14.27157066466917";

Deno.test("tleChecksum sums digits with '-' counting as one", () => {
  // The checksum is the last character; the sum is taken over the first 68.
  assertEquals(tleChecksum(N19_L1), 4);
  assertEquals(tleChecksum(N19_L2), 1);
});

Deno.test("isValidTleLine accepts real element lines", () => {
  assertEquals(isValidTleLine(N19_L1), true);
  assertEquals(isValidTleLine(N19_L2), true);
});

Deno.test("isValidTleLine rejects a corrupted line", () => {
  // Flip a digit in the body without fixing the checksum.
  const corrupted = `${N19_L1.slice(0, 20)}9${N19_L1.slice(21)}`;
  assertEquals(isValidTleLine(corrupted), false);
});

Deno.test("isValidTleLine rejects a truncated line", () => {
  assertEquals(isValidTleLine(N19_L1.slice(0, 40)), false);
});

Deno.test("parseTleText keys the three NOAA satellites by short id", () => {
  const text = `NOAA 19\n${N19_L1}\n${N19_L2}\nNOAA 15\n${N15_L1}\n${N15_L2}\n`;
  const parsed = parseTleText(text);
  assertEquals(Object.keys(parsed).sort(), ["15", "19"]);
  assertEquals(parsed["19"].name, "NOAA 19");
  assertEquals(parsed["19"].line1, N19_L1);
  assertEquals(parsed["15"].line2, N15_L2);
});

Deno.test("parseTleText ignores satellites outside the catalog", () => {
  // Real DMSP 5D-3 F16 elements — a weather satellite that is not an APT
  // satellite, so it must be filtered out by catalog number.
  const other1 = "1 28054U 03048A   26207.58535321  .00000021  00000+0  34680-4 0  9990";
  const other2 = "2 28054  98.9888 231.6728 0007770  42.8290 122.8338 14.14485310175052";
  const text = `DMSP 5D-3 F16 (USA 172)\n${other1}\n${other2}\nNOAA 19\n${N19_L1}\n${N19_L2}\n`;
  assertEquals(Object.keys(parseTleText(text)), ["19"]);
});

Deno.test("parseTleText handles Celestrak's CRLF line endings", () => {
  // Celestrak serves \r\n and pads name lines with trailing spaces. Both
  // would push every line past the 69-character check if left in place.
  const text = `NOAA 19                 \r\n${N19_L1}\r\n${N19_L2}\r\n`;
  const parsed = parseTleText(text);
  assertEquals(Object.keys(parsed), ["19"]);
  assertEquals(parsed["19"].name, "NOAA 19");
  assertEquals(parsed["19"].line1, N19_L1);
});

Deno.test("parseTleText drops element sets that fail validation", () => {
  const corrupted = `${N19_L1.slice(0, 20)}9${N19_L1.slice(21)}`;
  assertEquals(parseTleText(`NOAA 19\n${corrupted}\n${N19_L2}\n`), {});
});
