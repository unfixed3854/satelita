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
import { type Station, readStation, writeStation } from "./station.ts";
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

// The `{ lat, lon, altM }` annotation is erased at build time, so the
// validator is the only runtime guard standing between a malformed request
// and a station.json the tracking route would then read back as "unset".
export const setStationFn = createServerFn({ method: "POST" })
  .validator((data: { lat: number; lon: number; altM: number }) => data)
  .handler(async ({ data }): Promise<Station> => {
    const station: Station = { ...data, source: "manual" };
    await writeStation(station);
    return station;
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
