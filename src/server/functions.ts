import { createServerFn } from "@tanstack/react-start";
import { activeSessionId, startRecording, stopRecording } from "./recorder.ts";
import { deleteRecording, listRecordings, type Recording } from "./recordings.ts";

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

export const deleteRecordingFn = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    if (data.id === activeSessionId()) {
      throw new Error("Cannot delete a recording that is currently in progress.");
    }
    await deleteRecording(data.id);
  });
