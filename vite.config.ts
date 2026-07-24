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
  // Without an explicit preset, Nitro's package-manager sniffing sees the
  // `npm_config_user_agent=deno/...` that `deno task` sets and infers a
  // Deno deployment target, switching to the `deno-server` preset. That
  // preset targets `deno run`/Deno Deploy directly and (as of nitro
  // 3.0.260311-beta) fails to build here; it's also the wrong target
  // anyway, since `deno desktop` serves this build itself. Pin the
  // Node-compatible preset so `npm run build` (and therefore
  // `deno task build`) is deterministic regardless of how it's invoked.
  plugins: [tanstackStart({ srcDirectory: "src" }), viteReact(), nitro({ preset: "node-server" })],
});
