# satelita

A desktop app for live-decoding NOAA weather-satellite APT transmissions
from an RTL-SDR dongle. Built with [TanStack Start](https://tanstack.com/start)
and packaged as a native app with [`deno desktop`](https://docs.deno.com/runtime/desktop/).

## Requirements

- [Deno](https://deno.com/) 2.9+
- `rtl_fm`, `rtl_test`, `sox`, and `satdump` on `PATH`
- An RTL-SDR dongle

## Using the app

The left rail holds capture settings and live telemetry; the rest of the
window is the decoded image.

- **Gain** — drag the slider, type an exact value, or switch on **AGC**.
  Watch the **Level** strip while adjusting: it reads `CLIP` in amber when
  the front end is saturating, which quietly ruins a pass.
- **Sync lock** — how well the decoder is locking onto APT's sync-A pulse
  train. Near zero means you are recording noise, not a satellite.
- **Recordings** — every past pass, with its duration and disk size. A
  recording holds roughly 7 MB of raw audio per minute plus a WAV copy of
  the same size, so the total in the panel header grows quickly. Aborted
  runs list dimmed with no image and are worth deleting.
- **Image stage** — `Fit width` / `1:1` zoom, and `A+B` / `A` /
  `B` to isolate one APT channel. Finished passes use satdump's calibrated
  per-channel images; the live view crops the canvas in half, so the sync
  and telemetry bars stay visible while a pass is running.
- **Tracking** — the `Tracking` tab shows where NOAA-15/18/19 are right
  now on an offline world map, with ground tracks, reception footprints and
  a day/night terminator. When your station pin falls inside a footprint,
  that satellite is above your horizon. The rail lists every pass over your
  location for the next 24 hours with its max elevation — passes below
  about 20° tend to be noisy and clipped by terrain. Set your coordinates
  in the **Station** panel; the first run tries to detect them from your IP
  address, and any manual edit takes precedence from then on. Orbital
  elements are fetched from Celestrak once a day and cached, so the map
  works offline.

## Development

```bash
npm install
deno task dev
```

Runs the plain TanStack Start (Vite) dev server in your browser at
`http://localhost:1420` — fast hot-reload for UI work, no native window.

```bash
deno task preview
```

Opens the app in a native `deno desktop` window, with hot reload — use it
for checking desktop-specific behavior (recording, window chrome). It
stays running and watches the project; press Ctrl-C to stop.

> **Task-naming constraint:** `deno desktop .` auto-detects the TanStack
> Start project and drives the framework through this repo's own Deno
> tasks — it runs `dev` in `--hmr` mode and `build` otherwise. So neither
> `dev` nor `build` may itself invoke `deno desktop`: doing so makes
> `deno desktop` re-detect the framework, re-run the task, and recurse
> forever (endless Vite/Nitro rebuild cycles, no window). That's the
> reason the packaging task is named `bundle` rather than `build`, and why
> `dev`/`build` stay plain `npm run` wrappers. This — not upstream
> instability — was the cause of the `dev` and `preview`/`build` loops
> previously seen here.
>
> Separately, `npm run dev` logs a harmless server-side error on every
> page load — `Error in renderToReadableStream: TypeError: Cannot read
> properties of null (reading 'useContext')` (or `'useSyncExternalStore'`),
> originating inside `@base-ui/react`'s `Select` component. This project's
> Deno-managed `node_modules` gives `@base-ui/react` and `@base-ui/utils`
> their own nested `react`/`react-dom` copies instead of deduping them,
> and Vite's dev-mode SSR module runner resolves into the wrong (nested)
> copy when rendering `Select`, leaving its hook dispatcher uninitialized.
> The client always successfully re-renders past this and the app is
> fully interactive — it's console noise, not a functional bug — and it
> does not occur in the production build (`deno task bundle`), where
> Nitro's Rollup-based bundler resolves the whole module graph itself
> instead of falling back to Node's native runtime resolution. It does
> appear under `deno task preview`, which runs that same dev server
> inside the native window.

## Build

```bash
deno task bundle
```

Runs `deno desktop`, which builds the web app (via the `build` task) and
packages it using the `desktop` block in `deno.json` (app metadata,
per-platform icons, and per-platform `output` paths). The output file
extension determines the installer format (`.app` on macOS, `.msi` on
Windows, `.AppImage` on Linux), so a native installer lands under `dist/`
for whichever platform you build on — no `--output` flag is needed on the
command line.

`deno task build` on its own is just the web build (`vite build && tsc
--noEmit`) with no packaging; it exists both as a quick type/build check
and because `deno desktop` calls it.

Verified in this repo: on Linux, `deno task bundle` runs end-to-end
headlessly (the compile/bundle step does not require a display) and
produces a working `dist/satelita.AppImage`. Packaging on macOS/Windows,
and actually launching the packaged app on any platform, has not been
exercised here.
