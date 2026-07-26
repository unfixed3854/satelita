import { assertEquals } from "@std/assert";
import { parseRtlDeviceList } from "./devices.ts";

Deno.test("parseRtlDeviceList parses one device per line", () => {
  const output = [
    "Found 2 device(s):",
    "  0:  Realtek, RTL2838UHIDIR, SN: 00000001",
    "  1:  Realtek, RTL2832U, SN: 00000002",
    "",
    "Invalid device index 999999",
  ].join("\n");

  assertEquals(parseRtlDeviceList(output), [
    { index: 0, manufacturer: "Realtek", product: "RTL2838UHIDIR", serial: "00000001" },
    { index: 1, manufacturer: "Realtek", product: "RTL2832U", serial: "00000002" },
  ]);
});

Deno.test("parseRtlDeviceList returns an empty list when none are attached", () => {
  assertEquals(parseRtlDeviceList("No supported devices found.\n"), []);
});

Deno.test("parseRtlDeviceList ignores unrelated lines", () => {
  const output = [
    "Found 1 device(s):",
    "  0:  Realtek, RTL2838UHIDIR, SN: 00000001",
    "Invalid device index 999999",
    "Some other unrelated diagnostic output",
  ].join("\n");

  assertEquals(parseRtlDeviceList(output), [
    { index: 0, manufacturer: "Realtek", product: "RTL2838UHIDIR", serial: "00000001" },
  ]);
});
