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
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom"],
  },
  ssr: {
    noExternal: ["@base-ui/react", "@base-ui/utils"],
  },
  // Without an explicit preset, Nitro's package-manager sniffing sees the
  // `npm_config_user_agent=deno/...` that `deno task` sets and infers a
  // Deno deployment target, switching to the `deno-server` preset. That
  // preset targets `deno run`/Deno Deploy directly and (as of nitro
  // 3.0.260311-beta) fails to build here; it's also the wrong target
  // anyway, since `deno desktop` serves this build itself. Pin the
  // Node-compatible preset so `npm run build` (and therefore
  // `deno task build`) is deterministic regardless of how it's invoked.
  plugins: [tailwindcss(), tanstackStart({ srcDirectory: "src" }), viteReact(), nitro({ preset: "node-server" })],
});
