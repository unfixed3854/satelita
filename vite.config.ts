import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";

export default defineConfig({
  server: {
    port: 1420,
  },
  // `src/server/recorder.ts` imports `@std/encoding/base64`, a JSR-only
  // specifier that only Deno's resolver understands (via the `imports` map
  // in `deno.json`). Vite's SSR bundler can't resolve it at build time, so
  // it must stay external in the built output; `deno desktop` supplies it
  // at runtime when it serves the Nitro build.
  build: {
    rolldownOptions: {
      external: ["@std/encoding/base64"],
    },
  },
  plugins: [tanstackStart({ srcDirectory: "src" }), viteReact(), nitro()],
});
