// In-memory pub/sub for pushing recorder events to connected SSE clients.
// Mirrors what Tauri's `app.emit()` did for every webview; here there can
// be multiple HTTP clients, so each gets its own SSE stream controller.

type Controller = ReadableStreamDefaultController<Uint8Array>;

const clients = new Set<Controller>();
const encoder = new TextEncoder();

/** The most recent `apt-status` frame, replayed to every new subscriber.
 *
 * Status is edge-triggered, not polled: it is emitted from readerLoop's
 * chunk loop and from finishDecode, and nothing at all is emitted between
 * "decoding" and "stopped". A client that connects during that gap — a
 * plain page reload mid-decode — would otherwise sit on its initial IDLE
 * state indefinitely, with Record enabled, and starting a second pass on
 * top of a still-running satdump is a keystroke away. Remembering the last
 * frame here rather than in each caller keeps "new subscribers get the
 * current state" a property of the pub/sub layer itself.
 *
 * Stored as the already-encoded frame so a replay is byte-identical to the
 * live broadcast: the client's `apt-status` listener cannot tell the two
 * apart and takes exactly the same code path. */
let lastStatusFrame: Uint8Array | null = null;

function encodeFrame(event: string, payload: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export function subscribe(controller: Controller): void {
  clients.add(controller);
  if (lastStatusFrame === null) return;
  try {
    controller.enqueue(lastStatusFrame);
  } catch {
    // Stream already closed between the request arriving and this replay.
    clients.delete(controller);
  }
}

export function unsubscribe(controller: Controller): void {
  clients.delete(controller);
}

export function broadcast(event: string, payload: unknown): void {
  const frame = encodeFrame(event, payload);
  if (event === "apt-status") lastStatusFrame = frame;
  for (const controller of clients) {
    try {
      controller.enqueue(frame);
    } catch {
      // Client disconnected without its abort signal firing yet; drop it.
      clients.delete(controller);
    }
  }
}

export function clientCount(): number {
  return clients.size;
}
