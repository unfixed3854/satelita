import { assertEquals, assertThrows } from "@std/assert";
import {
  assertRecordingNotBusy,
  busyRecordingId,
  bytesToSamples,
  chunkLevel,
  freqForSat,
  type RtlProcess,
  startRecording,
  stopRecording,
} from "./recorder.ts";
import { subscribe, unsubscribe } from "./events.ts";

Deno.test("freqForSat maps known satellites", () => {
  assertEquals(freqForSat("15"), "137.620M");
  assertEquals(freqForSat("18"), "137.9125M");
  assertEquals(freqForSat("19"), "137.100M");
  assertEquals(freqForSat("99"), undefined);
});

Deno.test("bytesToSamples decodes little-endian s16 pairs to [-1, 1] floats", () => {
  const carry = { byte: null as number | null };
  // s16 LE: 0x0000 -> 0.0, 0x7FFF -> ~1.0, 0x8000 -> -1.0
  const buf = new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80]);
  const samples = bytesToSamples(buf, carry);
  assertEquals(samples.length, 3);
  assertEquals(samples[0], 0);
  assertEquals(Math.abs(samples[1] - 0x7fff / 32768) < 1e-9, true);
  assertEquals(samples[2], -1);
  assertEquals(carry.byte, null);
});

Deno.test("bytesToSamples carries a trailing odd byte to the next call", () => {
  const carry = { byte: null as number | null };
  const first = bytesToSamples(new Uint8Array([0x00, 0x00, 0x11]), carry);
  assertEquals(first.length, 1);
  assertEquals(carry.byte, 0x11);

  const second = bytesToSamples(new Uint8Array([0x22]), carry);
  assertEquals(second.length, 1);
  assertEquals(carry.byte, null);
  const expected = ((0x22 << 8) | 0x11) / 32768;
  assertEquals(Math.abs(second[0] - expected) < 1e-9, true);
});

Deno.test("chunkLevel reports peak magnitude and RMS", () => {
  const { peak, rms } = chunkLevel(Float32Array.from([0.5, -0.8, 0.1, -0.2]));
  // Float32Array rounds -0.8 to the nearest float32 (~0.800000011920929
  // once promoted back to a double), so compare with tolerance rather
  // than exact equality.
  assertEquals(Math.abs(peak - 0.8) < 1e-6, true);
  const expected = Math.sqrt((0.25 + 0.64 + 0.01 + 0.04) / 4);
  assertEquals(Math.abs(rms - expected) < 1e-6, true);
});

Deno.test("chunkLevel handles an empty chunk without dividing by zero", () => {
  const { peak, rms } = chunkLevel(new Float32Array(0));
  assertEquals(peak, 0);
  assertEquals(rms, 0);
});

// --- startRecording / stopRecording / busyRecordingId -----------------
//
// These exercise the two most safety-critical paths in the recorder: the
// delete guard (busyRecordingId / assertRecordingNotBusy) and what happens
// when rtl_fm exits unexpectedly. Spawning a real rtl_fm needs
// `--allow-run` and the binary on PATH, neither of which `deno task test`
// grants (see deno.json) — and a real dongle can't be told to crash mid-
// pass on demand anyway — so `startRecording` takes an injectable
// `spawnRtl`, and everything below uses a fully in-memory fake process.

const ENV_KEYS = ["XDG_DATA_HOME", "HOME", "APPDATA"] as const;

/** Isolates appDataDir()/recordingsDir() to a temp directory for the
 * duration of `fn`, so these tests never touch a real recordings folder.
 * Mirrors recordings.test.ts's helper of the same shape. */
async function withTempRoot(fn: () => Promise<void>): Promise<void> {
  const tmp = await Deno.makeTempDir();
  const saved = ENV_KEYS.map((k) => [k, Deno.env.get(k)] as const);
  for (const k of ENV_KEYS) Deno.env.set(k, tmp);
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    await Deno.remove(tmp, { recursive: true });
  }
}

/** Polls `predicate` until it's true, for asserting on state that a
 * fire-and-forget background chain (the exit watcher, finishDecode) will
 * eventually settle into. */
async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A fully in-memory stand-in for `rtl_fm`'s process handle. `kill()`
 * mirrors what a real SIGTERM does — the process exits soon after, closing
 * both streams — so it's usable for both an explicit Stop (which calls
 * kill) and a simulated crash (which resolves the status/closes streams
 * directly, without kill ever being called, exactly like an unrequested
 * exit). */
function makeFakeRtl(): {
  proc: RtlProcess;
  stdout: ReadableStreamDefaultController<Uint8Array>;
  stderr: ReadableStreamDefaultController<Uint8Array>;
  resolveStatus: (code: number) => void;
} {
  let resolveStatus!: (v: Deno.CommandStatus) => void;
  const status = new Promise<Deno.CommandStatus>((res) => {
    resolveStatus = res;
  });
  const resolve = (code: number) => resolveStatus({ success: code === 0, code, signal: null });

  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      stdoutController = c;
    },
  });

  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  const stderr = new ReadableStream<Uint8Array>({
    start(c) {
      stderrController = c;
    },
  });

  const proc: RtlProcess = {
    stdout,
    stderr,
    status,
    kill: () => {
      resolve(0);
      try {
        stdoutController.close();
      } catch {
        // already closed
      }
      try {
        stderrController.close();
      } catch {
        // already closed
      }
    },
  };

  return { proc, stdout: stdoutController, stderr: stderrController, resolveStatus: resolve };
}

interface StatusEvent {
  state: string;
  message: string;
  elapsed_secs: number;
}

/** Subscribes to every `apt-status` broadcast via the real events.ts pub/
 * sub (the same path SSE clients use), decoding SSE frames back into
 * structured events. */
function subscribeStatus(onEvent: (e: StatusEvent) => void): () => void {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  subscribe(controller);

  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    const reader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = frame.split("\n");
          const eventLine = lines.find((l) => l.startsWith("event: "));
          const dataLine = lines.find((l) => l.startsWith("data: "));
          if (eventLine?.slice("event: ".length) === "apt-status" && dataLine) {
            onEvent(JSON.parse(dataLine.slice("data: ".length)));
          }
        }
      }
    } catch {
      // stream cancelled below
    }
  })();

  return () => {
    unsubscribe(controller);
    try {
      controller.close();
    } catch {
      // already closed
    }
  };
}

Deno.test("startRecording marks the new id busy immediately; an instant rtl_fm failure reports and releases it", async () => {
  await withTempRoot(async () => {
    const fake = makeFakeRtl();

    const startP = startRecording("15", "45", 0, () => fake.proc);
    await waitUntil(() => busyRecordingId() !== null);
    const id = busyRecordingId()!;
    assertEquals(/^noaa15-\d+$/.test(id), true);

    // Busy the whole time the guard exists to protect — deleting it now
    // must be refused. An unrelated id must not be affected.
    assertThrows(() => assertRecordingNotBusy(id), Error, "currently in progress");
    assertRecordingNotBusy("some-other-id");

    // rtl_fm rejects the device instantly: no stdout ever arrives.
    fake.stdout.close();
    fake.stderr.enqueue(new TextEncoder().encode("No supported devices found.\n"));
    fake.stderr.close();
    fake.resolveStatus(1);

    const msg = await startP;
    assertEquals(msg.includes("Recording NOAA-15"), true);

    await waitUntil(() => busyRecordingId() === null);
    // Released once the failure is fully reported — no longer refused.
    assertRecordingNotBusy(id);
  });
});

Deno.test("an unexpected rtl_fm exit with data already captured is not reported as a hard failure", async () => {
  await withTempRoot(async () => {
    const fake = makeFakeRtl();
    const events: StatusEvent[] = [];
    const stop = subscribeStatus((e) => events.push(e));

    try {
      const startP = startRecording("15", "45", 0, () => fake.proc);
      await waitUntil(() => busyRecordingId() !== null);
      await startP;

      // Some real audio arrives, then the dongle dies mid-pass — nobody
      // called Stop.
      fake.stdout.enqueue(new Uint8Array(4000));
      await waitUntil(() => events.some((e) => e.message.includes("Live") || e.message.includes("Waiting")));
      fake.stdout.close();
      fake.stderr.close();
      fake.resolveStatus(1);

      // The regression this guards against: previously *any* exit — even
      // mid-pass with real data already on disk — was reported as a hard
      // "rtl_fm failed" idle status and the run was abandoned outright.
      await waitUntil(() => events.some((e) => e.state === "decoding"));
      assertEquals(
        events.some((e) => e.state === "idle" && e.message.includes("rtl_fm failed")),
        false,
      );

      // finalDecode's own sox/satdump calls need --allow-run, which this
      // test task deliberately doesn't grant, so the eventual "stopped"
      // broadcast can't be observed here. What's confirmed either way:
      // the crash path took the decode branch (asserted above), and
      // busyId is still released once finishDecode's `finally` runs,
      // whether or not the decode itself could complete.
      await waitUntil(() => busyRecordingId() === null);
    } finally {
      stop();
    }
  });
});

Deno.test("stopRecording clears the session immediately, but busyRecordingId() stays set until the decode finishes", async () => {
  await withTempRoot(async () => {
    const fake = makeFakeRtl();
    const startP = startRecording("15", "45", 0, () => fake.proc);
    await waitUntil(() => busyRecordingId() !== null);
    const id = busyRecordingId()!;
    await startP;

    await stopRecording();

    // The exact window I4 exists to protect: capture has stopped (a new
    // startRecording() would now be allowed — session is null), but
    // sox/satdump haven't finished (or, with nothing captured here, even
    // started) writing into the directory yet, so it must still refuse
    // deletion.
    assertEquals(busyRecordingId(), id);
    assertThrows(() => assertRecordingNotBusy(id), Error, "currently in progress");

    // Nothing was captured, so finalDecode's own zero-byte check returns
    // before it would ever need sox/satdump (and thus --allow-run) — this
    // settles quickly and hermetically.
    await waitUntil(() => busyRecordingId() === null);
    assertRecordingNotBusy(id);
  });
});
