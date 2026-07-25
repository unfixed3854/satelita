import { assertEquals } from "@std/assert";
import { APT_LINE_WIDTH, CHANNEL_FRACTIONS, fmtBytes, fmtElapsed } from "./apt.ts";

Deno.test("fmtElapsed renders m:ss and pads seconds", () => {
  assertEquals(fmtElapsed(0), "0:00");
  assertEquals(fmtElapsed(9), "0:09");
  assertEquals(fmtElapsed(65), "1:05");
  assertEquals(fmtElapsed(600), "10:00");
  assertEquals(fmtElapsed(-5), "0:00");
});

Deno.test("fmtBytes scales and keeps one decimal below 10", () => {
  assertEquals(fmtBytes(512), "512 B");
  assertEquals(fmtBytes(1024), "1.0 KB");
  assertEquals(fmtBytes(13_213_696), "12.6 MB");
  assertEquals(fmtBytes(305_000_000), "291 MB");
});

Deno.test("channel fractions split the line in half", () => {
  assertEquals(APT_LINE_WIDTH, 2080);
  assertEquals(CHANNEL_FRACTIONS.both, { start: 0, width: 1 });
  assertEquals(CHANNEL_FRACTIONS.a, { start: 0, width: 0.5 });
  assertEquals(CHANNEL_FRACTIONS.b, { start: 0.5, width: 0.5 });
});
