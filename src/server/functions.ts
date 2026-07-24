import { createServerFn } from "@tanstack/react-start";
import { startRecording, stopRecording } from "./recorder.ts";

type StartInput = { sat: string; gain: string; device: number };

export const startRecordingFn = createServerFn({ method: "POST" })
  .validator((data: StartInput) => data)
  .handler(async ({ data }) => {
    return await startRecording(data.sat, data.gain, data.device);
  });

export const stopRecordingFn = createServerFn({ method: "POST" }).handler(async () => {
  return await stopRecording();
});
