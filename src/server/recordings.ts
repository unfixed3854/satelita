// Browsing and removing past APT recordings.
//
// Each run lives in its own directory under the app data dir, named
// `noaa<sat>-<startEpoch>` (see recorder.ts). A completed run's decode/
// holds satdump's output: raw_sync.png (2080 px, both channels plus sync
// and telemetry) and APT-A.png / APT-B.png (909 px video only), alongside
// dataset.json with the satellite name and start timestamp. An aborted
// run has an empty decode/ but still holds a signal.raw worth ~7 MB per
// minute, which is exactly what makes deletion worth offering.

import { CAPTURE_RATE } from "./constants.ts";
import { appDataDir } from "./paths.ts";

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
 * so this is a correctness requirement, not defense in depth.
 *
 * Takes `unknown` on purpose. The value reaching here has only ever been
 * *typed* as a string — server-fn validators are erased at runtime, so a
 * POST carrying `{"id": ["noaa15-1785000000"]}` arrives as a real array.
 * `RegExp.test` would coerce that to the same characters and pass, while
 * every `===` comparison against it (notably `assertRecordingNotBusy`)
 * would be false — letting a non-string sneak past the busy guard and
 * still resolve to a real directory. Narrowing to `string` here closes
 * that asymmetry for every caller at once. */
export function isValidRecordingId(id: unknown): id is string {
  return typeof id === "string" && ID_PATTERN.test(id);
}

/** Narrow an untrusted server-fn payload to a valid recording id, or throw.
 * Lives here rather than inline in functions.ts so the boundary check is
 * unit testable without going through the `createServerFn` wrapper. */
export function parseRecordingId(data: unknown): string {
  const id = (data as { id?: unknown } | null | undefined)?.id;
  if (!isValidRecordingId(id)) {
    throw new Error(`Invalid recording id: ${typeof id === "string" ? id : typeof id}`);
  }
  return id;
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
  // `id` is only *declared* as a string — see isValidRecordingId's note on
  // erased validators. Interpolating an arbitrary object into the message
  // could itself throw, so report the type instead when it isn't a string.
  if (!isValidRecordingId(id)) {
    throw new Error(`Invalid recording id: ${typeof id === "string" ? id : typeof id}`);
  }
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
