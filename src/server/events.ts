// In-memory pub/sub for pushing recorder events to connected SSE clients.
// Mirrors what Tauri's `app.emit()` did for every webview; here there can
// be multiple HTTP clients, so each gets its own SSE stream controller.

type Controller = ReadableStreamDefaultController<Uint8Array>;

const clients = new Set<Controller>();
const encoder = new TextEncoder();

export function subscribe(controller: Controller): void {
  clients.add(controller);
}

export function unsubscribe(controller: Controller): void {
  clients.delete(controller);
}

export function broadcast(event: string, payload: unknown): void {
  const frame = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
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
