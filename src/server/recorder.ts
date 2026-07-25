// NOAA APT live recorder — ported from src-tauri/src/recorder.rs (removed).
// `rtl_fm` owns the SDR and streams FM-demodulated audio straight into an
// async reader loop, which (a) appends the raw samples to `signal.raw` for
// the final satdump decode, and (b) feeds them to an incremental
// AptDecoder that emits image lines the moment they are decoded
// (~2 lines/second).
//
// Broadcast events (see events.ts):
//   apt-line   { start_line, width, count, pixels_b64 }
//   apt-signal { peak, rms, sync, lines, elapsed_secs }
//   apt-final  { id }
//   apt-status { state, message, elapsed_secs }

import { AptDecoder, APT_LINE_WIDTH } from "./apt-decoder.ts";
import { CAPTURE_RATE } from "./constants.ts";
import { broadcast } from "./events.ts";
import { recordingsDir } from "./paths.ts";

// `@std/encoding/base64` is a JSR-only specifier: Deno resolves it fine at
// runtime, but Vite's production bundler, dev-mode dependency scanner, and
// dev-mode SSR module runner each needed separate, incomplete workarounds
// to tolerate it. `btoa` is a standard Web API — identical behavior in
// Deno, Node, and the browser, no bundler special-casing needed. Mirrors
// the client's own `atob`-based `b64ToBytes` in src/routes/index.tsx.
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function freqForSat(sat: string): string | undefined {
  switch (sat) {
    case "15":
      return "137.620M";
    case "18":
      return "137.9125M";
    case "19":
      return "137.100M";
    default:
      return undefined;
  }
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function emitStatus(state: string, message: string, elapsedSecs: number): void {
  broadcast("apt-status", { state, message, elapsed_secs: elapsedSecs });
}

/** Convert a chunk of little-endian s16 PCM bytes to [-1, 1] float samples,
 * carrying a possible odd trailing byte over to the next call. */
export function bytesToSamples(buf: Uint8Array, carry: { byte: number | null }): Float32Array {
  const samples: number[] = [];
  let idx = 0;
  if (carry.byte !== null && buf.length >= 1) {
    const lo = carry.byte;
    const hi = buf[0];
    const u = (hi << 8) | lo;
    const signed = u >= 0x8000 ? u - 0x10000 : u;
    samples.push(signed / 32768);
    idx = 1;
    carry.byte = null;
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (idx + 1 < buf.length) {
    samples.push(view.getInt16(idx, true) / 32768);
    idx += 2;
  }
  if (idx < buf.length) {
    carry.byte = buf[idx];
  }
  return Float32Array.from(samples);
}

/** Peak magnitude and RMS of a sample chunk, for the UI's level meter.
 * Peak is what reveals clipping; RMS is what tracks the pass envelope. */
export function chunkLevel(samples: Float32Array): { peak: number; rms: number } {
  let peak = 0;
  let sumSq = 0;
  for (const s of samples) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
    sumSq += s * s;
  }
  return { peak, rms: samples.length > 0 ? Math.sqrt(sumSq / samples.length) : 0 };
}

/** The subset of `Deno.ChildProcess` the recorder actually uses. Narrowing
 * to an interface (rather than depending on `Deno.ChildProcess` directly)
 * lets tests inject a fake process — spawning a real `rtl_fm` needs
 * `--allow-run` and the binary on PATH, neither of which `deno task test`
 * grants, and the two paths this file's tests exist to cover (an instant
 * failure, and an unexpected mid-pass exit) are exactly the ones you can't
 * reliably provoke from a real dongle on demand anyway. */
export interface RtlProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<Deno.CommandStatus>;
  kill(signal?: Deno.Signal): void;
}

export type SpawnRtl = (args: string[]) => RtlProcess;

function spawnRtlProcess(args: string[]): RtlProcess {
  return new Deno.Command("rtl_fm", { args, stdout: "piped", stderr: "piped" }).spawn();
}

interface Session {
  rtl: RtlProcess;
  reader: Promise<void>;
  runDir: string;
  id: string;
  sat: string;
  startEpoch: number;
}

let session: Session | null = null;
let starting = false;

/** Id of the recording currently "busy": from the moment startRecording
 * creates its directory through the end of its sox/satdump decode — a
 * strictly wider window than `session`, which clears the instant capture
 * itself stops (see stopRecording/finishDecode below). sox and satdump go
 * on writing into `decode/` for a while after that, so deleting the
 * directory needs to stay blocked for that whole stretch, not just while
 * rtl_fm is running. */
let busyId: string | null = null;

/** Id of the recording currently being captured or decoded, or null when
 * idle. Guards deletion — see `assertRecordingNotBusy`. */
export function busyRecordingId(): string | null {
  return busyId;
}

/** Throws if `id` names the recording currently busy (see
 * `busyRecordingId`). Exported as its own function, rather than inlined at
 * the one call site in functions.ts, so the guard's exact behavior is unit
 * testable without going through the `createServerFn` wrapper. */
export function assertRecordingNotBusy(id: string): void {
  if (id === busyId) {
    throw new Error("Cannot delete a recording that is currently in progress.");
  }
}

/** Drain a child's stderr into its log file while also returning the text,
 * so a failure (e.g. rtl_fm rejecting an unknown device) can be reported
 * back to the client instead of only ending up in a log file nobody reads. */
async function captureStderr(
  stream: ReadableStream<Uint8Array>,
  logFile: Deno.FsFile,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      await logFile.write(value);
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
    logFile.close();
  }
  return text;
}

/** Bytes written to `signal.raw` so far — the difference between "rtl_fm
 * rejected the device instantly" (nothing worth decoding) and "rtl_fm died
 * mid-pass" (minutes of signal worth keeping). */
async function rawBytesCaptured(runDir: string): Promise<number> {
  try {
    return (await Deno.stat(`${runDir}/signal.raw`)).size;
  } catch {
    return 0;
  }
}

async function readerLoop(
  stdout: ReadableStream<Uint8Array>,
  rawPath: string,
  startEpoch: number,
): Promise<void> {
  const rawFile = await Deno.open(rawPath, { create: true, write: true, truncate: true });
  const decoder = new AptDecoder(CAPTURE_RATE);
  const carry = { byte: null as number | null };
  let lastStatus = -1;
  let lastSignalMs = 0;

  const reader = stdout.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      await rawFile.write(value);

      const samples = bytesToSamples(value, carry);
      const startLine = decoder.linesOut;
      const lines = decoder.process(samples);
      if (lines.length > 0) {
        const flat = new Uint8Array(lines.length * APT_LINE_WIDTH);
        lines.forEach((l, i) => flat.set(l, i * APT_LINE_WIDTH));
        broadcast("apt-line", {
          start_line: startLine,
          width: APT_LINE_WIDTH,
          count: lines.length,
          pixels_b64: encodeBase64(flat),
        });
      }

      // 4 Hz is the fastest the meter strips can show; rtl_fm delivers
      // chunks faster than that.
      const nowMs = Date.now();
      if (nowMs - lastSignalMs >= 250) {
        lastSignalMs = nowMs;
        const { peak, rms } = chunkLevel(samples);
        broadcast("apt-signal", {
          peak,
          rms,
          sync: decoder.lastSyncScore,
          lines: decoder.linesOut,
          elapsed_secs: nowSecs() - startEpoch,
        });
      }

      const elapsed = nowSecs() - startEpoch;
      if (elapsed !== lastStatus) {
        lastStatus = elapsed;
        const msg = decoder.linesOut > 0 ? `Live · ${decoder.linesOut} lines` : "Waiting for signal…";
        emitStatus("recording", msg, elapsed);
      }
    }
  } finally {
    reader.releaseLock();
    rawFile.close();
  }
}

/** Run sox + satdump on the full recording for the polished final image. */
async function finalDecode(runDir: string, sat: string, startEpoch: number): Promise<Uint8Array | null> {
  const raw = `${runDir}/signal.raw`;
  const snap = `${runDir}/snapshot.wav`;
  const decodeDir = `${runDir}/decode`;

  try {
    const stat = await Deno.stat(raw);
    if (stat.size === 0) return null;
  } catch {
    return null;
  }

  const sox = await new Deno.Command("sox", {
    args: ["-t", "raw", "-r", String(CAPTURE_RATE), "-e", "signed", "-b", "16", "-c", "1", raw, snap],
    stderr: "null",
  }).output();
  if (!sox.success) return null;

  await new Deno.Command("satdump", {
    args: [
      "legacy",
      "noaa_apt",
      "audio_wav",
      snap,
      decodeDir,
      "--satellite_number",
      sat,
      "--start_timestamp",
      String(startEpoch),
    ],
    stdout: "null",
    stderr: "null",
  }).output();

  try {
    return await Deno.readFile(`${decodeDir}/raw_sync.png`);
  } catch {
    return null;
  }
}

/** Run sox/satdump on whatever `current` captured and report the result,
 * then clear `busyId`. Shared by an explicit Stop and by the exit watcher
 * in startRecording below when rtl_fm crashes mid-pass with something
 * worth decoding: a crash 8 minutes into a 12-minute pass still has 8
 * minutes of `signal.raw` worth keeping, so both paths finish the same way
 * instead of the crash path abandoning the run. Assumes the child has
 * already exited (or been killed) and `current.reader` has already been
 * drained — callers are responsible for that part, since it differs
 * slightly between an explicit Stop (kill, then wait) and a crash (already
 * exited, nothing to kill). */
async function finishDecode(current: Session): Promise<void> {
  const elapsed = nowSecs() - current.startEpoch;
  emitStatus("decoding", "Running final decode…", elapsed);

  try {
    const png = await finalDecode(current.runDir, current.sat, current.startEpoch);
    if (png) {
      // Just the id — the client fetches the image from
      // /api/recordings/:id/:image, which the browser can cache.
      broadcast("apt-final", { id: current.id });
    }
    emitStatus("stopped", `Stopped. Files in ${current.runDir}`, elapsed);
  } finally {
    if (busyId === current.id) busyId = null;
  }
}

export async function startRecording(
  sat: string,
  gain: string,
  device: number,
  spawnRtl: SpawnRtl = spawnRtlProcess,
): Promise<string> {
  if (session !== null || starting) {
    throw new Error("Already recording — stop the current pass first.");
  }
  starting = true;

  try {
    const freq = freqForSat(sat);
    if (!freq) throw new Error("Unknown satellite (use 15, 18 or 19).");

    const startEpoch = nowSecs();
    const id = `noaa${sat}-${startEpoch}`;
    const runDir = recordingsDir(id);
    await Deno.mkdir(`${runDir}/decode`, { recursive: true });

    const rtlArgs = ["-d", String(device), "-f", freq, "-M", "fm", "-s", String(CAPTURE_RATE), "-E", "dc", "-F", "9"];
    if (gain !== "agc" && gain !== "auto") {
      rtlArgs.push("-g", gain);
    }
    rtlArgs.push("-");

    let rtl: RtlProcess;
    try {
      rtl = spawnRtl(rtlArgs);
    } catch (e) {
      throw new Error(`Failed to start rtl_fm: ${e instanceof Error ? e.message : e}`);
    }

    const rtlLog = await Deno.open(`${runDir}/rtl.log`, { create: true, write: true, truncate: true });
    // Attached immediately: a write error (ENOSPC, say) or `logFile.close()`
    // throwing shouldn't be able to reject this promise with nobody
    // listening. Without the .catch, nothing awaits it until the watcher
    // below gets past `await rtl.status` — i.e. for the whole of a
    // successful recording — and an unhandled rejection takes the whole
    // Deno process down mid-pass.
    const stderrText = captureStderr(rtl.stderr, rtlLog).catch((e) => {
      console.error(`[recorder] stderr capture for ${id} failed:`, e);
      return "";
    });

    const rawPath = `${runDir}/signal.raw`;
    const reader = readerLoop(rtl.stdout, rawPath, startEpoch);

    session = { rtl, reader, runDir, id, sat, startEpoch };
    busyId = id;

    // rtl_fm can die at any point in a pass — instantly if it rejects a bad
    // device, or minutes in if the dongle is unplugged. Neither readerLoop
    // (which just sees stdout close) nor the caller of startRecording
    // (whose response has already gone out) notices that on its own, so
    // watch the child's exit here.
    (async () => {
      const status = await rtl.status;
      const stderrMsg = (await stderrText).trim();
      // Always drain `reader` — previously, on the "nothing captured"
      // branch below, nobody awaited or caught it once `session` was
      // nulled, so a readerLoop rejection (e.g. its `finally`'s
      // `rawFile.close()` throwing) was permanently unhandled. Awaiting a
      // promise twice (stopRecording may also be awaiting it) is fine.
      await reader.catch((e) => {
        console.error(`[recorder] reader for ${id} failed:`, e);
      });

      // If `session` no longer points at this exact process, stopRecording
      // already handled it — it always clears `session` before killing.
      if (session?.rtl !== rtl) return;
      session = null;

      const captured = await rawBytesCaptured(runDir);
      if (captured === 0) {
        // Nothing worth decoding — most commonly an instant rejection
        // before a single sample arrived. Report it directly; there is no
        // point running finalDecode against an empty file.
        if (busyId === id) busyId = null;
        const reason = stderrMsg || `rtl_fm exited unexpectedly (code ${status.code}).`;
        emitStatus("idle", `rtl_fm failed: ${reason}`, nowSecs() - startEpoch);
        return;
      }

      // Something was captured before the crash — finish the same way an
      // explicit Stop would, so it isn't lost.
      await finishDecode({ rtl, reader, runDir, id, sat, startEpoch });
    })().catch((e) => {
      // Belt and suspenders: every `await` above already has its own
      // handler, but a bug in this IIFE itself must not become an
      // unhandled rejection that kills the server mid-pass.
      console.error(`[recorder] exit watcher for ${id} failed:`, e);
    });

    emitStatus("recording", `Recording NOAA-${sat} on ${freq}`, 0);
    return `Recording NOAA-${sat} (${freq})`;
  } finally {
    starting = false;
  }
}

export async function stopRecording(): Promise<string> {
  if (session === null) {
    throw new Error("Not recording.");
  }
  const current = session;
  session = null;

  try {
    current.rtl.kill("SIGTERM");
  } catch {
    // already exited
  }
  await current.rtl.status.catch(() => {});
  await current.reader.catch((e) => {
    console.error(`[recorder] reader for ${current.id} failed:`, e);
  });

  // Fire-and-forget: the decode itself (sox + satdump) can take a while,
  // and the caller only needs to know the capture has stopped, not that
  // the decode has finished. finishDecode has its own error handling and
  // clears `busyId` in a `finally`, so a decode failure can't leave the
  // directory permanently undeletable — but it also must not become an
  // unhandled rejection.
  void finishDecode(current).catch((e) => {
    console.error(`[recorder] finishDecode for ${current.id} failed:`, e);
  });

  return current.runDir;
}

/** Kill any active session's SDR process (used on process exit). */
export function abortActiveSession(): void {
  if (session !== null) {
    try {
      session.rtl.kill("SIGTERM");
    } catch {
      // already exited
    }
    session = null;
  }
  busyId = null;
}

// `vite dev` runs this module under Node, where `globalThis.addEventListener`
// doesn't exist — this listener only matters in the Deno desktop runtime, so
// guard it the same way the signal listeners below are already guarded.
if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("unload", () => {
    abortActiveSession();
  });
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  try {
    Deno.addSignalListener(signal, () => {
      abortActiveSession();
      Deno.exit();
    });
  } catch {
    // Signal not supported on this platform (e.g. some SIGINT/SIGTERM
    // combinations on Windows) — unload listener above is the fallback.
  }
}
