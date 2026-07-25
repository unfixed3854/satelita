# satelita

A desktop app for live-decoding NOAA weather-satellite APT transmissions
from an RTL-SDR dongle. Built with [TanStack Start](https://tanstack.com/start)
and packaged as a native app with [`deno desktop`](https://docs.deno.com/runtime/desktop/).

## Requirements

- [Deno](https://deno.com/) 2.9+
- `rtl_fm`, `sox`, and `satdump` on `PATH`
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

Builds once and opens the app in a native `deno desktop` window, for
checking desktop-specific behavior (recording, window chrome). This is a
one-shot launch, not a watch loop — re-run it after making changes.

> **Known issue:** `deno desktop --hmr` (previously used for `dev`) has a
> self-triggering watch loop — it writes its own bootstrap file into the
> project root while watching that same root, so it immediately restarts
> itself, forever. That's why `dev` no longer uses `deno desktop` at all.
> Separately, `deno desktop` without `--hmr` (used by `preview`/`build`)
> has been observed to occasionally loop internally too (repeated Nitro
> rebuild cycles with no completion) even after clearing its compile cache
> at `~/.cache/deno/desktop/`. It's worked reliably at other times in this
> repo's history (see `dist/satelita.AppImage` having been produced
> end-to-end previously). `deno desktop` is explicitly experimental — if
> `preview`/`build` hangs, try clearing `~/.cache/deno/desktop/` and
> `node_modules/.nitro/` and retrying; if it still hangs, that's an
> upstream `deno desktop` instability, not a project misconfiguration.
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
> does not occur in the production build (`deno task build`/`preview`),
> where Nitro's Rollup-based bundler resolves the whole module graph
> itself instead of falling back to Node's native runtime resolution.

## Build

```bash
deno task build
```

Runs `npm run build` and then `deno desktop`, which packages the app using
the `desktop` block in `deno.json` (app metadata, per-platform icons, and
per-platform `output` paths). The output file extension determines the
installer format (`.app` on macOS, `.msi` on Windows, `.AppImage` on Linux),
so a native installer lands under `dist/` for whichever platform you build
on — no `--output` flag is needed on the command line.

Verified in this repo: on Linux, `deno task build` runs end-to-end
headlessly (the compile/bundle step does not require a display) and
produces a working `dist/satelita.AppImage`. Packaging on macOS/Windows,
and actually launching the packaged app on any platform, has not been
exercised here.
