// Browsing and removing past APT recordings.
//
// Each run lives in its own directory under the app data dir, named
// `noaa<sat>-<startEpoch>` (see recorder.ts). A completed run's decode/
// holds satdump's output: raw_sync.png (2080 px, both channels plus sync
// and telemetry) and APT-A.png / APT-B.png (909 px video only), alongside
// dataset.json with the satellite name and start timestamp. An aborted
// run has an empty decode/ but still holds a signal.raw worth ~7 MB per
// minute, which is exactly what makes deletion worth offering.

import { appDataDir } from "./paths.ts";
import { CAPTURE_RATE } from "./recorder.ts";

const ID_PATTERN = /^noaa\d+-\d+$/;

/** The satdump outputs the UI is allowed to serve. */
export const FINAL_IMAGES = ["raw_sync", "APT-A", "APT-B"] as const;
export type FinalImage = (typeof FINAL_IMAGES)[number];

export interface Recording {
  id: string;
  satellite: string;
  startedAt: number;
  durationSecs: number;
  bytes: number;
  images: string[];
  complete: boolean;
}

/** Ids arrive from the client and are concatenated into filesystem paths,
 * so this is a correctness requirement, not defense in depth. */
export function isValidRecordingId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function isFinalImage(name: string): name is FinalImage {
  return (FINAL_IMAGES as readonly string[]).includes(name);
}

export function recordingsRoot(): string {
  return `${appDataDir()}/recordings`;
}

async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) total += await dirBytes(path);
    else if (entry.isFile) total += (await Deno.stat(path)).size;
  }
  return total;
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await Deno.stat(path)).size;
  } catch {
    return 0;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readRecording(root: string, id: string): Promise<Recording> {
  const dir = `${root}/${id}`;
  const [prefix, epoch] = id.split("-");

  let satellite = `NOAA-${prefix.slice("noaa".length)}`;
  let startedAt = Number(epoch);
  try {
    const meta = JSON.parse(await Deno.readTextFile(`${dir}/decode/dataset.json`));
    if (typeof meta.satellite === "string") satellite = meta.satellite;
    if (typeof meta.timestamp === "number") startedAt = Math.floor(meta.timestamp);
  } catch {
    // Aborted run, or satdump never wrote metadata — the directory name
    // already encodes both values.
  }

  const images: string[] = [];
  for (const name of FINAL_IMAGES) {
    if (await exists(`${dir}/decode/${name}.png`)) images.push(name);
  }

  return {
    id,
    satellite,
    startedAt,
    // Exact, not estimated: the capture is raw s16 mono at CAPTURE_RATE.
    durationSecs: Math.round((await fileSize(`${dir}/signal.raw`)) / (CAPTURE_RATE * 2)),
    bytes: await dirBytes(dir),
    images,
    complete: images.length > 0,
  };
}

export async function listRecordings(): Promise<Recording[]> {
  const root = recordingsRoot();

  const ids: string[] = [];
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.isDirectory && isValidRecordingId(entry.name)) ids.push(entry.name);
    }
  } catch {
    return []; // Nothing recorded yet.
  }

  const out = await Promise.all(ids.map((id) => readRecording(root, id)));
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out;
}

export async function deleteRecording(id: string): Promise<void> {
  if (!isValidRecordingId(id)) throw new Error(`Invalid recording id: ${id}`);
  await Deno.remove(`${recordingsRoot()}/${id}`, { recursive: true });
}

/** PNG bytes for one of a recording's final images, or null if the id or
 * image name is not allowed or the file does not exist. */
export async function readFinalImage(id: string, image: string): Promise<Uint8Array | null> {
  if (!isValidRecordingId(id) || !isFinalImage(image)) return null;
  try {
    return await Deno.readFile(`${recordingsRoot()}/${id}/decode/${image}.png`);
  } catch {
    return null;
  }
}
