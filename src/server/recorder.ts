// NOAA APT live recorder — ported from src-tauri/src/recorder.rs (removed).
// `rtl_fm` owns the SDR and streams FM-demodulated audio straight into an
// async reader loop, which (a) appends the raw samples to `signal.raw` for
// the final satdump decode, and (b) feeds them to an incremental
// AptDecoder that emits image lines the moment they are decoded
// (~2 lines/second).
//
// Broadcast events (see events.ts), same shape as the old Tauri events:
//   apt-line   { start_line, width, count, pixels_b64 }
//   apt-final  { data_url }
//   apt-status { state, message, elapsed_secs }

import { encodeBase64 } from "@std/encoding/base64";
import { AptDecoder, APT_LINE_WIDTH } from "./apt-decoder.ts";
import { broadcast } from "./events.ts";
import { recordingsDir } from "./paths.ts";

const CAPTURE_RATE = 60_000; // rtl_fm FM-demod output rate (also the DSP rate)

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

interface Session {
  rtl: Deno.ChildProcess;
  reader: Promise<void>;
  runDir: string;
  sat: string;
  startEpoch: number;
}

let session: Session | null = null;
let starting = false;

async function readerLoop(
  stdout: ReadableStream<Uint8Array>,
  rawPath: string,
  startEpoch: number,
): Promise<void> {
  const rawFile = await Deno.open(rawPath, { create: true, write: true, truncate: true });
  const decoder = new AptDecoder(CAPTURE_RATE);
  const carry = { byte: null as number | null };
  let lastStatus = -1;

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

export async function startRecording(sat: string, gain: string, device: number): Promise<string> {
  if (session !== null || starting) {
    throw new Error("Already recording — stop the current pass first.");
  }
  starting = true;

  try {
    const freq = freqForSat(sat);
    if (!freq) throw new Error("Unknown satellite (use 15, 18 or 19).");

    const startEpoch = nowSecs();
    const runDir = recordingsDir(`noaa${sat}-${startEpoch}`);
    await Deno.mkdir(`${runDir}/decode`, { recursive: true });

    const rtlArgs = ["-d", String(device), "-f", freq, "-M", "fm", "-s", String(CAPTURE_RATE), "-E", "dc", "-F", "9"];
    if (gain !== "agc" && gain !== "auto") {
      rtlArgs.push("-g", gain);
    }
    rtlArgs.push("-");

    let rtl: Deno.ChildProcess;
    try {
      rtl = new Deno.Command("rtl_fm", { args: rtlArgs, stdout: "piped", stderr: "piped" }).spawn();
    } catch (e) {
      throw new Error(`Failed to start rtl_fm: ${e instanceof Error ? e.message : e}`);
    }

    const rtlLog = await Deno.open(`${runDir}/rtl.log`, { create: true, write: true, truncate: true });
    rtl.stderr.pipeTo(rtlLog.writable).catch(() => {});

    const rawPath = `${runDir}/signal.raw`;
    const reader = readerLoop(rtl.stdout, rawPath, startEpoch);

    session = { rtl, reader, runDir, sat, startEpoch };

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
  await current.rtl.status;
  await current.reader;

  const elapsed = nowSecs() - current.startEpoch;
  emitStatus("stopped", "Running final decode…", elapsed);

  (async () => {
    const png = await finalDecode(current.runDir, current.sat, current.startEpoch);
    if (png) {
      broadcast("apt-final", { data_url: `data:image/png;base64,${encodeBase64(png)}` });
    }
    emitStatus("stopped", `Stopped. Files in ${current.runDir}`, elapsed);
  })();

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
}

globalThis.addEventListener("unload", () => {
  abortActiveSession();
});

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
