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

Deno.test("broadcast fans out to every subscribed client", async () => {
  const a = makeStream();
  const b = makeStream();
  subscribe(a.controller);
  subscribe(b.controller);

  broadcast("apt-status", { state: "recording", message: "hi", elapsed_secs: 0 });

  const decoder = new TextDecoder();
  const { value: valueA } = await a.stream.getReader().read();
  const { value: valueB } = await b.stream.getReader().read();

  assertEquals(
    decoder.decode(valueA),
    'event: apt-status\ndata: {"state":"recording","message":"hi","elapsed_secs":0}\n\n',
  );
  assertEquals(decoder.decode(valueB), decoder.decode(valueA));

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
