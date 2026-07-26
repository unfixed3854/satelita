import { createServerFn } from "@tanstack/react-start";
import { listRtlDevices, type RtlDevice } from "./devices.ts";
import { assertRecordingNotBusy, startRecording, stopRecording } from "./recorder.ts";
import {
  deleteRecording,
  listRecordings,
  parseRecordingId,
  type Recording,
} from "./recordings.ts";

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
