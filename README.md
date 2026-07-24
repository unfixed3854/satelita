# satelita

A desktop app for live-decoding NOAA weather-satellite APT transmissions
from an RTL-SDR dongle. Built with [TanStack Start](https://tanstack.com/start)
and packaged as a native app with [`deno desktop`](https://docs.deno.com/runtime/desktop/).

## Requirements

- [Deno](https://deno.com/) 2.9+
- `rtl_fm`, `sox`, and `satdump` on `PATH`
- An RTL-SDR dongle

## Development

```bash
npm install
deno task dev
```

Opens a native window against the TanStack Start dev server with hot reload.

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
