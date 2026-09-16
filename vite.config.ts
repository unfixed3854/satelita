import path from "node:path";
import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";

export default defineConfig({
  server: {
    port: 1420,
  },
  // satellite.js ships a pthreads-enabled WASM runtime that spawns its own
  // Worker; Vite's default worker output is IIFE, which can't express that
  // module's top-level await and fails the build the moment anything
  // client-side imports satellite.js (world-map.tsx does, for the
  // terminator's subsolar point). ES module workers support top-level
  // await, so this is the fix rather than a workaround.
  worker: {
    format: "es",
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  // Without an explicit preset, Nitro's package-manager sniffing sees the
  // `npm_config_user_agent=deno/...` that `deno task` sets and infers a
  // Deno deployment target, switching to the `deno-server` preset. That
  // preset targets `deno run`/Deno Deploy directly and (as of nitro
  // 3.0.260311-beta) fails to build here; it's also the wrong target
  // anyway, since `deno desktop` serves this build itself. Pin the
  // Node-compatible preset so `deno task build` is deterministic regardless
  // of how it's invoked.
  plugins: [
    tailwindcss(),
    tanstackStart({ srcDirectory: "src" }),
    viteReact(),
    nitro({ preset: "node-server" }),
  ],
});
