import { createFileRoute } from "@tanstack/react-router";
import { readFinalImage } from "../../server/recordings.ts";

export const Route = createFileRoute("/api/recordings/$id/$image")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        // readFinalImage validates both params against an allowlist before
        // building any path.
        const png = await readFinalImage(params.id, params.image);
        if (!png) return new Response("Not found", { status: 404 });

        return new Response(png, {
          headers: {
            "Content-Type": "image/png",
            // A recording's id embeds its start epoch and its decoded
            // images never change, so this is safe to cache hard.
            "Cache-Control": "private, max-age=31536000, immutable",
          },
        });
      },
    },
  },
});
