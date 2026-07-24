import { createFileRoute } from "@tanstack/react-router";
import { subscribe, unsubscribe } from "../../server/events.ts";

export const Route = createFileRoute("/api/recorder-events")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        let ctrl: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            ctrl = controller;
            subscribe(controller);
          },
          cancel() {
            unsubscribe(ctrl);
          },
        });

        request.signal.addEventListener("abort", () => {
          unsubscribe(ctrl);
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        });
      },
    },
  },
});
