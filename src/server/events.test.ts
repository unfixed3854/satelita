import { assertEquals } from "@std/assert";
import { broadcast, clientCount, subscribe, unsubscribe } from "./events.ts";

function makeStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return { stream, controller };
}

const decoder = new TextDecoder();

/** Read the next frame a subscriber received, as text. The lock is released
 * after each read so a test can pull several frames off the same stream. */
async function nextFrame(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  try {
    const { value } = await reader.read();
    return decoder.decode(value);
  } finally {
    reader.releaseLock();
  }
}

// NOTE: `events.ts` remembers the last apt-status frame for the lifetime of
// the module, so that is deliberately module-global state shared by every
// test here. The replay tests below each broadcast their own status before
// subscribing, which makes them independent of whatever ran earlier; the
// first test runs before anything has been broadcast, so its subscribers
// get no replay.
Deno.test("broadcast fans out to every subscribed client", async () => {
  const a = makeStream();
  const b = makeStream();
  subscribe(a.controller);
  subscribe(b.controller);

  broadcast("apt-status", { state: "recording", message: "hi", elapsed_secs: 0 });

  const frameA = await nextFrame(a.stream);
  const frameB = await nextFrame(b.stream);

  assertEquals(
    frameA,
    'event: apt-status\ndata: {"state":"recording","message":"hi","elapsed_secs":0}\n\n',
  );
  assertEquals(frameB, frameA);

  unsubscribe(a.controller);
  unsubscribe(b.controller);
});

Deno.test("unsubscribe stops a client from receiving further broadcasts", () => {
  const before = clientCount();
  const a = makeStream();
  subscribe(a.controller);
  assertEquals(clientCount(), before + 1);
  unsubscribe(a.controller);
  assertEquals(clientCount(), before);
});

Deno.test("a new subscriber is replayed the last apt-status, byte for byte", async () => {
  // Broadcast before subscribing so there is definitely a remembered frame:
  // `live` then receives exactly one replay, and the next frame it reads is
  // unambiguously the live broadcast below.
  broadcast("apt-status", { state: "recording", message: "earlier", elapsed_secs: 1 });

  const live = makeStream();
  subscribe(live.controller);
  assertEquals(
    await nextFrame(live.stream),
    'event: apt-status\ndata: {"state":"recording","message":"earlier","elapsed_secs":1}\n\n',
  );

  broadcast("apt-status", { state: "decoding", message: "Running final decode…", elapsed_secs: 42 });
  const liveFrame = await nextFrame(live.stream);
  unsubscribe(live.controller);

  // This is the reload-during-DECODING case: nothing is broadcast between
  // "decoding" and "stopped", so without a replay this client would sit on
  // its initial IDLE state — with Record enabled — until the decode ended.
  const late = makeStream();
  subscribe(late.controller);

  const replayed = await nextFrame(late.stream);
  assertEquals(
    replayed,
    'event: apt-status\ndata: {"state":"decoding","message":"Running final decode…","elapsed_secs":42}\n\n',
  );
  // Identical to what a live subscriber saw, so the client's apt-status
  // listener cannot distinguish the two and takes the same code path.
  assertEquals(replayed, liveFrame);

  unsubscribe(late.controller);
});

Deno.test("only apt-status is remembered, and only the most recent one", async () => {
  broadcast("apt-status", { state: "recording", message: "first", elapsed_secs: 1 });
  broadcast("apt-status", { state: "stopped", message: "second", elapsed_secs: 2 });
  // Non-status traffic must not become the snapshot a reloading client sees.
  broadcast("apt-line", { start_line: 0, width: 2080, count: 1, pixels_b64: "AA==" });
  broadcast("apt-signal", { peak: 0.99, rms: 0.4, sync: 1, lines: 3, elapsed_secs: 2 });

  const late = makeStream();
  subscribe(late.controller);

  assertEquals(
    await nextFrame(late.stream),
    'event: apt-status\ndata: {"state":"stopped","message":"second","elapsed_secs":2}\n\n',
  );

  unsubscribe(late.controller);
});
