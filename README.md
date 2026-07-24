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
npm run build
deno task build
```

Produces a native installer under `dist/` for the current platform.
