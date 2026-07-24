# Migrate satelita from Tauri to TanStack Start (deno desktop)

Date: 2026-07-24

## Context

`satelita` is a desktop app for live-decoding NOAA weather-satellite APT
transmissions from an RTL-SDR dongle. Today it's a Tauri 2 app: a Rust
backend spawns `rtl_fm` to pull FM-demodulated audio from the SDR, decodes it
in real time into 8-bit grayscale image lines via a hand-written DSP pipeline
(`src-tauri/src/apt.rs`), streams those lines to the React frontend over
Tauri's event system, and on stop runs `sox` + `satdump` to produce a
polished final image. `src-tauri/src/recorder.rs` orchestrates process
spawning, the reader/decode loop, and session lifecycle (including killing
the SDR process if the window closes mid-pass).

Goal: migrate off Tauri/Rust entirely onto
[`deno desktop`](https://docs.deno.com/runtime/desktop/) (shipped in Deno
2.9, June 2026), which wraps a web project's dev/production server in a
native OS webview with framework auto-detection — including TanStack Start.

## Why TanStack Start + deno desktop

`deno desktop` auto-detects TanStack Start via `@tanstack/{react,solid}-start`
in `package.json` and the Nitro `.output/server` build artifact. It runs the
dev server directly with `--hmr` for development, and packages the
production build into native installers (`.app`/`.dmg`, `.exe`/`.msi`,
`.AppImage`/`.deb`/`.rpm`) with `deno desktop build`. No Electron, no Rust
toolchain.

Its frontend↔backend bridge (`bindings` — `win.bind("name", handler)` on the
server, `bindings.name()` on the client) is request/response RPC only, with
no built-in server→client push. Since this app's core UX is a real-time
stream of decoded image lines, we don't use `bindings` for that; see
"Real-time transport" below.

## Architecture

- **UI layer**: TanStack Start (Vite + React + TanStack Router), served by
  Deno.
- **Real-time push**: Server-Sent Events (SSE), served as a plain TanStack
  Start server route returning a streamed `text/event-stream` Response. This
  replaces Tauri's `emit`/`listen`. SSE is a standard browser API
  (`EventSource`) with no desktop-specific dependency, and needs only a GET
  request — no upgrade handshake like WebSocket.
- **Actions**: `startRecording` / `stopRecording` as TanStack Start server
  functions (`createServerFn`), replacing
  `invoke("start_recording" | "stop_recording")`.
- **Process + DSP logic**: ported from Rust to TypeScript, running
  server-side under Deno. `Deno.Command` replaces Rust's `std::process::Command`
  for spawning `rtl_fm`, `sox`, and `satdump`.
- **Packaging**: `deno desktop dev --hmr` for development,
  `npm run build && deno desktop build` for native installers.

`rtl_fm`, `sox`, and `satdump` remain required system-installed binaries on
`PATH` — this migration doesn't change that dependency, only what spawns
them.

## Components

| New file | Replaces | Purpose |
|---|---|---|
| `app/routes/index.tsx` | `src/App.tsx` | Same UI; `invoke()` → server functions, `listen()` → `EventSource` |
| `app/server/apt-decoder.ts` | `src-tauri/src/apt.rs` | 1:1 port of the DSP pipeline: subcarrier mixing, 2-pole low-pass envelope detection, box-average resampling to pixel rate, adaptive mean/std normalization, sync-A correlation line alignment |
| `app/server/recorder.ts` | `src-tauri/src/recorder.rs` | Session singleton (module-scoped state — one active recording at a time), spawns `rtl_fm`/`sox`/`satdump` via `Deno.Command`, reader loop over `stdout`, writes `signal.raw` |
| `app/server/events.ts` | Tauri's `emit`/`listen` | In-memory pub/sub: a `Set` of active SSE stream controllers; `broadcast(event, payload)` fans out to all connected clients |
| `app/routes/api/recorder/events.ts` | — | SSE server route: on GET, registers the connection in the pub/sub and streams `apt-line` / `apt-status` / `apt-final` as `text/event-stream`; deregisters on client disconnect (abort signal) |
| `app/server/functions.ts` | `#[tauri::command]` handlers | `createServerFn` wrappers around `recorder.ts`'s `startRecording`/`stopRecording` |

Event payload shapes are unchanged from today (`LinePayload { start_line,
width, count, pixels_b64 }`, `StatusPayload { state, message, elapsed_secs }`,
`FinalPayload { data_url }`), so `App.tsx`'s canvas-drawing logic
(`drawRows`, `ensureHeight`, `b64ToBytes`, `resetCanvas`) ports over
unchanged — only the subscription mechanism (`EventSource` instead of
`listen()`) and the action calls (server functions instead of `invoke()`)
change.

## Data flow

- **Start**: client calls `startRecording({ sat, gain, device })` → server
  validates satellite/frequency, resolves a recordings directory, spawns
  `rtl_fm` via `Deno.Command`, starts an async reader loop over
  `child.stdout` that (a) appends raw audio to `signal.raw` and (b) feeds
  the ported `AptDecoder`, and `broadcast()`s `apt-line` / `apt-status` to
  all connected SSE clients as lines complete (~2 lines/sec).
- **Stop**: client calls `stopRecording()` → server kills the `rtl_fm`
  child, joins the reader loop, broadcasts a `"stopped"` status, then kicks
  off `sox` + `satdump` in the background for the polished final decode and
  broadcasts `apt-final` with a `data:` URL once the PNG is ready — mirroring
  today's async final-decode flow.
- **Cleanup on quit**: Tauri's `on_window_event(Destroyed)` hook
  (`abort_on_exit`) is replaced with a Deno `unload`/signal listener
  (`addEventListener("unload", ...)` and/or `Deno.addSignalListener`) that
  kills any active `rtl_fm` child before the process exits. This is a plain
  Deno API, independent of whatever window-close hook (if any) `deno
  desktop` itself exposes — so it works regardless of that detail.

## Error handling

Behavior parity with today:

- "Already recording — stop the current pass first" guard, via the same
  single-session-singleton check.
- Spawn failures (missing `rtl_fm`/`sox`/`satdump` on `PATH`) surfaced as
  status/error text rather than raw exceptions.
- Client-side `try/catch` around server-function calls sets the same
  `error` state shown in the UI today.
- SSE reconnects automatically per spec on a dropped connection; a
  reconnect after a network blip can miss lines broadcast in the gap. This
  is not a regression — Tauri's `emit` was equally fire-and-forget with no
  replay buffer.

## Testing

Port `apt.rs`'s `reconstructs_synthetic_apt` test to a Vitest test for
`apt-decoder.ts`: synthesize an AM-modulated test image at the subcarrier
frequency, feed it through the decoder in realistic chunk sizes, and assert
a Pearson correlation > 0.85 between a decoded line and the best-matching
source line. This is the load-bearing check that the TypeScript rewrite of
the DSP math is faithful to the Rust original — the DSP logic is pure
number-crunching over `Float32Array`/typed arrays with no Deno-specific
APIs, so it's testable in isolation from process spawning.

No new integration tests for the `rtl_fm`/`sox`/`satdump` pipeline itself —
matching today's project, which has no automated integration tests against
real hardware or those external tools either.

## Packaging / dev workflow

- **Dev**: `deno desktop dev` (or equivalent invocation) pointed at the
  project root, running TanStack Start's Vite dev server with `--hmr` —
  replaces `npm run tauri dev`.
- **Build**: `npm run build` (TanStack Start/Nitro build to `.output/`),
  then `deno desktop build` to produce native installers — replaces
  `tauri build`.
- **Permissions**: `deno desktop` needs run/read/write permissions
  equivalent to what `src-tauri/capabilities/default.json` grants today
  (spawning `rtl_fm`/`sox`/`satdump`, reading/writing the recordings
  directory). The exact deno-desktop-side permission config mechanism isn't
  fully pinned down yet — first implementation task is to spike this and
  confirm the right flags/config file.
- **Icons**: reuse the existing PNG/ICO/ICNS assets under
  `src-tauri/icons/`, referenced from whatever `deno desktop` uses in place
  of `tauri.conf.json`'s `bundle.icon` list.
- **Removed entirely**: `src-tauri/` (Cargo.toml, Cargo.lock, `lib.rs`,
  `main.rs`, `recorder.rs`, `apt.rs`, `build.rs`, `tauri.conf.json`,
  `capabilities/`), the `@tauri-apps/*` npm dependencies, and `tools/`
  (`record-noaa.sh` + `viewer.html` — a standalone bash/Python CLI
  prototype unrelated to the app; removed rather than migrated).

## Open implementation risks (spike early, don't block on them here)

1. Exact `deno desktop` permission configuration for `--allow-run` /
   `--allow-read` / `--allow-write` (and whatever's needed for the local
   HTTP/SSE server).
2. Confirming SSE streams cleanly through `deno desktop`'s embedded webview
   — should be plain HTTP with nothing desktop-specific involved, but worth
   an early smoke test before building the full recorder around it.

## Out of scope

No UI/UX redesign — this is a framework/runtime migration only, same look
and behavior. `rtl_fm`/`sox`/`satdump` remain required system binaries
either way.
