import { createServerFn } from "@tanstack/react-start";
import { listRtlDevices, type RtlDevice } from "./devices.ts";
import { lookupCoordinates } from "./geoip.ts";
import { assertRecordingNotBusy, startRecording, stopRecording } from "./recorder.ts";
import {
  deleteRecording,
  listRecordings,
  parseRecordingId,
  type Recording,
} from "./recordings.ts";
import { isValidStation, type Station, readStation, writeStation } from "./station.ts";
import { getTles, type TleResult } from "./tle.ts";

type StartInput = { sat: string; gain: string; device: number };

export const startRecordingFn = createServerFn({ method: "POST" })
  .validator((data: StartInput) => data)
  .handler(async ({ data }) => {
    return await startRecording(data.sat, data.gain, data.device);
  });

export const stopRecordingFn = createServerFn({ method: "POST" }).handler(async () => {
  return await stopRecording();
});

export const listRecordingsFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<Recording[]> => {
    return await listRecordings();
  },
);

export const listDevicesFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<RtlDevice[]> => {
    return await listRtlDevices();
  },
);

// The validator is the only runtime type check on this payload: the
// `{ id: string }` annotation is erased at build time, so an id that is
// not a string (an array, say) would otherwise reach `assertRecordingNotBusy`
// — where `===` against the busy id is always false — and then a path
// template that coerces it right back to a real directory name. Fail fast
// here, and belt-and-braces inside deleteRecording via isValidRecordingId.
export const deleteRecordingFn = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => ({ id: parseRecordingId(data) }))
  .handler(async ({ data }) => {
    assertRecordingNotBusy(data.id);
    await deleteRecording(data.id);
  });

export const getTleFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<TleResult> => {
    return await getTles();
  },
);

export const getStationFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<Station | null> => {
    return await readStation();
  },
);

// The `{ lat, lon, altM }` annotation is erased at build time, so this
// validator is the request's first real runtime guard — it fails fast at
// the boundary rather than letting a malformed payload travel down to
// writeStation, which validates again before touching disk. Same
// belt-and-braces shape as deleteRecordingFn above.
export const setStationFn = createServerFn({ method: "POST" })
  .validator((data: { lat: number; lon: number; altM: number }): Station => {
    const station: Station = { ...data, source: "manual" };
    if (!isValidStation(station)) {
      throw new Error(`Invalid station: ${JSON.stringify(data)}`);
    }
    return station;
  })
  .handler(async ({ data }): Promise<Station> => {
    await writeStation(data);
    return data;
  });

// Runs only when getStationFn returned null, or when the operator presses
// Detect. Composes the two modules rather than letting geoip.ts touch disk.
export const detectStationFn = createServerFn({ method: "POST" }).handler(
  async (): Promise<Station> => {
    const { lat, lon } = await lookupCoordinates();
    const station: Station = { lat, lon, altM: 0, source: "auto" };
    await writeStation(station);
    return station;
  },
);
