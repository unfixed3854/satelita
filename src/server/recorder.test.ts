import { assertEquals } from "@std/assert";
import { bytesToSamples, freqForSat } from "./recorder.ts";

Deno.test("freqForSat maps known satellites", () => {
  assertEquals(freqForSat("15"), "137.620M");
  assertEquals(freqForSat("18"), "137.9125M");
  assertEquals(freqForSat("19"), "137.100M");
  assertEquals(freqForSat("99"), undefined);
});

Deno.test("bytesToSamples decodes little-endian s16 pairs to [-1, 1] floats", () => {
  const carry = { byte: null as number | null };
  // s16 LE: 0x0000 -> 0.0, 0x7FFF -> ~1.0, 0x8000 -> -1.0
  const buf = new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80]);
  const samples = bytesToSamples(buf, carry);
  assertEquals(samples.length, 3);
  assertEquals(samples[0], 0);
  assertEquals(Math.abs(samples[1] - 0x7fff / 32768) < 1e-9, true);
  assertEquals(samples[2], -1);
  assertEquals(carry.byte, null);
});

Deno.test("bytesToSamples carries a trailing odd byte to the next call", () => {
  const carry = { byte: null as number | null };
  const first = bytesToSamples(new Uint8Array([0x00, 0x00, 0x11]), carry);
  assertEquals(first.length, 1);
  assertEquals(carry.byte, 0x11);

  const second = bytesToSamples(new Uint8Array([0x22]), carry);
  assertEquals(second.length, 1);
  assertEquals(carry.byte, null);
  const expected = ((0x22 << 8) | 0x11) / 32768;
  assertEquals(Math.abs(second[0] - expected) < 1e-9, true);
});
