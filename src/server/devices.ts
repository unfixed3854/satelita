// RTL-SDR device enumeration for the "Device" select in CapturePanel.
//
// librtlsdr's CLI tools (rtl_test, rtl_sdr, ...) all share the same
// verbose_device_search: before doing anything else they print
// "Found N device(s):" followed by one "  <index>:  <manufacturer>,
// <product>, SN: <serial>" line per attached dongle, then try to open the
// index that was passed in. Passing an index no real dongle count reaches
// (RTL_TEST_DEVICE_INDEX) makes that open fail immediately and rtl_test
// exit right after printing the list — so this gets the device list
// without ever grabbing a dongle out from under a real capture.

const RTL_TEST_DEVICE_INDEX = "999999";

export interface RtlDevice {
  index: number;
  manufacturer: string;
  product: string;
  serial: string;
}

const DEVICE_LINE = /^\s*(\d+):\s+(.*?),\s*(.*?),\s*SN:\s*(.*?)\s*$/;

/** Parses rtl_test/rtl_sdr's stderr device listing. Pure so it can be unit
 * tested without spawning a real process or owning a dongle. */
export function parseRtlDeviceList(output: string): RtlDevice[] {
  const devices: RtlDevice[] = [];
  for (const line of output.split("\n")) {
    const match = DEVICE_LINE.exec(line);
    if (!match) continue;
    const [, index, manufacturer, product, serial] = match;
    devices.push({ index: Number(index), manufacturer, product, serial });
  }
  return devices;
}

export async function listRtlDevices(): Promise<RtlDevice[]> {
  const output = await new Deno.Command("rtl_test", {
    args: ["-d", RTL_TEST_DEVICE_INDEX],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return parseRtlDeviceList(new TextDecoder().decode(output.stderr));
}
