# Redesign satelita's UI as a dark instrument panel

Date: 2026-07-25

## Context

`satelita` decodes NOAA APT weather-satellite transmissions live from an
RTL-SDR dongle. Its entire UI is one 244-line route
(`src/routes/index.tsx`) that simultaneously owns the SSE subscription,
canvas rasterization, page layout, and all form controls. The July 2026
shadcn/Base UI migration replaced the hand-rolled stylesheet with shadcn's
stock `nova` theme, but it was explicitly a chrome swap — the layout and
information architecture are unchanged from the original Tauri app.

The result works but is hard to use:

- Long freeform status sentences are rendered inside a `Badge`, a component
  sized for short labels. Real messages overflow it — e.g.
  `"Stopped. Files in /home/magmast/.local/share/com.magmast.satelita/recordings/noaa15-1784913812"`.
- Controls are an undifferentiated wrapping flex row. The Device input is
  a 48px box (`className="w-12"`) sitting beside a full-width Gain input,
  with no grouping or hierarchy.
- Gain is a free-text field whose placeholder is `"45 or agc"` — the
  control users touch most often has the least guidance.
- The 2080px-wide canvas is squashed to `w-full` with no zoom control and
  no way to view a single APT channel. There is no 1:1 view for inspecting
  detail.
- The decoded image is lost on reload. Recordings are written to disk but
  nothing in the app ever lists, reopens, or removes them.
- There is no signal feedback at all, so setting gain is pure guesswork —
  you cannot tell a locked APT signal from recorded noise until the pass
  is over.

Two facts about the existing system shape this design, both verified
against real on-disk data during brainstorming:

**satdump already emits per-channel images.** A completed recording's
`decode/` directory contains `raw_sync.png` (2080×220), `APT-A.png`
(909×220), and `APT-B.png` (909×220), plus `dataset.json` with the
satellite name and start timestamp. Channel separation for finished
passes needs no cropping — satdump has already done it, better.

**Disk usage is real and invisible.** `~/.local/share/com.magmast.satelita/recordings/`
currently holds 291 MB across 9 passes. `signal.raw` is 60 kHz s16 mono
≈ 7 MB/minute, and `stopRecording` additionally writes a `snapshot.wav`
of the same size. Two of the nine directories have an empty `decode/` —
aborted runs that left raw audio behind and produced no image.

## Goals

Redesign the UI as a dark instrument panel, and add the capability that
makes the redesign worth doing: live signal metering, a usable image
viewer, and a recordings library.

Out of scope: orbital pass prediction, TLE fetching, auto-record
scheduling, false-color composites, light mode.

## Decisions

- **Layout**: persistent left rail (capture controls, signal meters,
  recordings) plus an image stage occupying the rest of the window.
  Controls stay visible without competing with the image for vertical
  space.
- **Theme**: dark-only, signal-green accent. `<html className="dark">`
  stays — shadcn components use `dark:` variants, so removing the class
  would silently change their rendering. `:root` and `.dark` receive
  identical values so there is no second palette to keep in sync.
- **Red is reserved.** Destructive red is used only for the recording
  indicator, the Stop button, and errors. Green means locked/live.
- **Meters show history, not instantaneous values.** A pass rises and
  falls over 10–15 minutes; a bar meter cannot show pass shape, whether
  you are past peak elevation, or whether a gain change helped.
- **No new npm dependencies.** Mono numerics use Tailwind's built-in
  `font-mono` system stack rather than adding `@fontsource-variable/geist-mono`.
  The one new UI primitive (`Slider`) is added via the shadcn CLI and is
  built on `@base-ui/react`, which is already a dependency.

## 1 · Visual system — `src/app.css`

Replace the stock `nova` neutral grayscale with an instrument palette.
Both `:root` and `.dark` get these values.

```
--background:          oklch(0.145 0.008 240)   /* near-black, cool cast */
--foreground:          oklch(0.96  0.005 240)
--card:                oklch(0.19  0.008 240)
--card-foreground:     oklch(0.96  0.005 240)
--popover:             oklch(0.20  0.008 240)
--popover-foreground:  oklch(0.96  0.005 240)
--primary:             oklch(0.80  0.19  148)   /* signal green */
--primary-foreground:  oklch(0.16  0.03  148)
--secondary:           oklch(0.26  0.008 240)
--secondary-foreground:oklch(0.96  0.005 240)
--muted:               oklch(0.24  0.008 240)
--muted-foreground:    oklch(0.68  0.008 240)
--accent:              oklch(0.26  0.010 148)
--accent-foreground:   oklch(0.90  0.100 148)
--destructive:         oklch(0.65  0.21  25)
--border:              oklch(1 0 0 / 10%)
--input:               oklch(1 0 0 / 14%)
--ring:                oklch(0.80  0.19  148 / 60%)
```

Instrument-specific tokens, exposed through `@theme inline` as
`--color-signal`, `--color-signal-dim`, `--color-signal-warn`,
`--color-grid`:

```
--signal:       oklch(0.80 0.19 148)   /* locked / live */
--signal-dim:   oklch(0.46 0.09 148)   /* unlocked / idle trace */
--signal-warn:  oklch(0.80 0.16 75)    /* amber — approaching clip */
--grid:         oklch(1 0 0 / 6%)      /* meter gridlines */
```

`--chart-1..5` are currently all-gray placeholders from the shadcn preset
and are unused; repoint `--chart-1`/`--chart-2` at `--signal` and
`--signal-warn` and leave the rest.

All numeric readouts (elapsed, line count, dB, byte sizes, timestamps)
use `font-mono tabular-nums` so they do not jitter as digits change.

## 2 · Component structure

`src/routes/index.tsx` becomes composition plus the start/stop actions.
New files:

| File | Purpose |
|---|---|
| `src/lib/apt.ts` | APT geometry constants, channel fractions, `fmtElapsed`, `fmtBytes`, `fmtClock` |
| `src/hooks/use-recorder-events.ts` | Owns the `EventSource`; returns typed recorder state and takes an `onLine` callback |
| `src/components/status-header.tsx` | State chip, satellite + frequency, elapsed timer |
| `src/components/capture-panel.tsx` | Satellite select, gain slider, device, Record/Stop |
| `src/components/signal-panel.tsx` | Level + sync-lock history strips, line counter |
| `src/components/recordings-panel.tsx` | List, open, delete |
| `src/components/image-stage.tsx` | Canvas + final-image viewer, zoom/channel modes, Save |

`use-recorder-events.ts` owns all SSE parsing and returns:

```ts
type RecorderState = {
  state: "idle" | "recording" | "decoding" | "stopped";
  message: string;
  elapsed: number;
  lines: number;
  finalUrl: string | null;
  level: Float32Array;   // rolling ring buffer, newest last
  sync: Float32Array;    // rolling ring buffer, newest last
};
```

Line payloads do not enter React state — they go straight to the `onLine`
callback so the canvas is written imperatively, as today. Putting ~2
lines/second of pixel data through `setState` would re-render the tree
twice a second for no reason.

## 3 · Signal telemetry

### `src/server/apt-decoder.ts`

`findLineStart()` already computes `bestScore`, the sync-A template
correlation, and currently discards it. Expose it as a normalized
`lastSyncScore` getter (read-only — the existing `process()` contract and
`apt-decoder.test.ts` are untouched).

Raw correlation is `Σ t_k · (pixbuf[o+k] − mean)` over `SYNC_TPL = 28`
taps with `t_k = ±1`, so `bestScore / (SYNC_TPL · std)` is the sync
amplitude in units of the pixel standard deviation. Two constants map it
to 0..1:

```ts
const SYNC_NOISE_FLOOR = 0.5;  // best-of-65 offsets on noise
const SYNC_FULL_LOCK   = 1.5;  // clean sync-A pulse train
lastSyncScore = clamp((raw - SYNC_NOISE_FLOOR) / (SYNC_FULL_LOCK - SYNC_NOISE_FLOOR), 0, 1)
```

The noise floor is an estimate: correlating 28 random taps gives
`sd(score) ≈ std·√28`, and taking the best of 65 offsets pulls roughly
2.7 sd, which lands near 0.5 in these units. **Both constants must be
calibrated against measured values** — the implementation prints the raw
score for the synthetic APT signal and for white noise, and the constants
are set from those measurements rather than from this derivation.

### `src/server/recorder.ts`

In `readerLoop`, compute `peak` and `rms` over each sample chunk and read
`decoder.lastSyncScore`. Broadcast a new event, throttled to 4 Hz
(chunks arrive faster than that and the strips cannot show more):

```
apt-signal  { peak, rms, sync, lines, elapsed_secs }
```

### A distinct `decoding` state

`stopRecording` currently emits `state: "stopped"` twice — once with
`"Running final decode…"` and again with `"Stopped. Files in …"` after
satdump returns. The UI therefore cannot distinguish "satdump is still
working" from "finished", except by string-matching the message.

Change the first of those emissions to `state: "decoding"`. This is the
only server-side status change, and it exists so the state chip can show
`DECODING` honestly instead of inferring it. The old client line
`if (payload.state === "stopped") setRecording(false)` is replaced by the
hook's state machine, in which both `decoding` and `stopped` mean "not
recording".

### `src/components/signal-panel.tsx`

Two ~90-second scrolling strips drawn on small canvases:

- **Level** — RMS as a filled trace with peak as a lighter overlay.
  Turns `--signal-warn` amber at peak ≥ 0.95, the silent pass-killer.
- **Sync lock** — `--signal` green when locked, `--signal-dim` when not.
  This is the readout that distinguishes decoding APT from recording noise.

Both share a strip primitive kept inside `signal-panel.tsx`; it is small
and has no other consumer.

## 4 · Recordings

### `src/server/recordings.ts`

```ts
type Recording = {
  id: string;          // "noaa15-1784827259"
  satellite: string;   // "NOAA-15"
  startedAt: number;   // epoch seconds
  durationSecs: number;
  bytes: number;       // total on disk, whole directory
  images: string[];    // subset of ["raw_sync", "APT-A", "APT-B"]
  complete: boolean;   // images.length > 0
};
```

`listRecordings()` scans `${appDataDir()}/recordings`, preferring
`decode/dataset.json` (`satellite`, `timestamp`) for metadata and falling
back to parsing the `noaa<N>-<epoch>` directory name — necessary because
aborted runs have an empty `decode/`. Results sort newest first.

Duration is derived exactly from the raw capture, not guessed:
`signal.raw` bytes ÷ (`CAPTURE_RATE` × 2). The 13,213,696-byte sample
recording gives 110 s, matching its wall-clock length.

`deleteRecording(id)` validates `id` against `/^noaa\d+-\d+$/` **before
touching the filesystem**, then removes the directory recursively. This
is the one destructive operation in the app and the id reaches it from
the client, so the guard is a correctness requirement, not defense in
depth.

Both are exposed as server functions in `src/server/functions.ts`
(`listRecordingsFn`, `deleteRecordingFn`).

### `src/routes/api/recordings.$id.$image.ts`

`GET /api/recordings/:id/:image` serves PNG bytes with
`Content-Type: image/png`. `id` gets the same regex validation; `image`
is checked against the exact allowlist `["raw_sync", "APT-A", "APT-B"]`
and the `.png` extension is appended server-side, so no
caller-controlled string is ever concatenated into a path.

A route rather than a server function: `raw_sync.png` is ~875 KB, and
base64-inflating that through the RPC layer on every list click would be
wasteful when the browser can cache a plain image response.

### `src/components/recordings-panel.tsx`

Each row shows satellite, local start time, duration, and size. Clicking
a complete recording loads it into the stage. Opening past recordings is
disabled while a recording is active, so browsing history cannot clobber
a live pass in progress — the rows stay visible and deletion of *other*
recordings stays available. Incomplete recordings
(empty `decode/`) render dimmed and non-openable but remain deletable —
they are precisely the ones wasting space. Delete requires confirmation
and refreshes the list. The panel header shows total disk usage across
all recordings, so the 291 MB is visible rather than discovered later.

The list refetches when a recording finishes (on `apt-final`, and on a
status transition to `stopped`).

## 5 · Image stage

**Zoom modes** — `Fit width` (default), `Whole`, `1:1`. Fit width scales
the image to the viewport width, never magnifying past 1:1; `Whole`
contains the entire image; `1:1` renders at native resolution with
scrolling, which is what makes 2080px-wide detail actually inspectable.

**Auto-follow**: during a live pass the stage scrolls to the newest lines
only when the viewport is already at the bottom. Today it force-scrolls
on every batch, so scrolling up to look at earlier lines is undone twice
a second.

**Channel modes** — `Both / A / B`.
- Live (canvas): proportional crop — channel A is the first 50% of the
  line, B the second. Fractions rather than fixed pixel offsets so the
  crop stays correct regardless of canvas width. The live crop includes
  the sync and telemetry bars, which is useful here: you can see sync
  locking in real time.
- Finished (image): swap the `src` to satdump's `APT-A` / `APT-B`
  endpoint. These are the calibrated 909px video regions with sync,
  space, and telemetry already stripped.

**When no final image arrives**: `finalDecode` returns `null` whenever
`signal.raw` is empty or satdump fails, in which case `apt-final` never
fires. The stage keeps showing the live canvas with whatever lines were
decoded, rather than clearing to an empty state — those lines are the
only result that run produced. The channel toggle falls back to
proportional cropping in this case, since there are no `APT-A`/`APT-B`
files to swap to.

**Save** downloads the current view as PNG — the fetched file for a
finished pass, or `canvas.toBlob()` for whatever is decoded so far during
a live one.

**Status presentation**: the state chip (`IDLE` / `RECORDING` with a
pulsing red dot / `DECODING` / `STOPPED`) is short and fixed-width and
lives in the stage header. The freeform message moves to a single
truncating line beneath the stage with the full text as a `title`
attribute, which is what makes the long recordings-path message
survivable. Errors render as a dismissible banner in the stage header
rather than an `Alert` inserted into the flex column, so showing one no
longer shoves the image down the page.

## 6 · Gain control

Gain becomes a `Slider` (0–49.6 dB, the RTL-SDR R820T range) paired with
a numeric field for exact entry, plus an **AGC** toggle that disables
both and sends `"agc"`. This preserves every value the current text field
accepts while making the common case direct.

`Slider` is added with `npx shadcn@latest add slider`, consistent with
how the other primitives in `src/components/ui/` were installed. It is
built on `@base-ui/react`, already a dependency — `package.json` gains no
new entry.

`startRecording` already treats `"agc"` and `"auto"` as "omit `-g`"; that
server logic is unchanged.

## 7 · Testing

New tests:

- `apt-decoder.test.ts` — sync quality is high (> 0.5) for the existing
  synthetic APT signal and low (< 0.2) for white noise. The test prints
  raw scores so the two normalization constants can be calibrated from
  measurement.
- `recordings.test.ts` — `deleteRecording` rejects ids containing `..`,
  `/`, or absolute paths before any filesystem access; `listRecordings`
  parses names, derives duration from `signal.raw` size, sums directory
  bytes, and flags empty-`decode/` runs as incomplete. Runs against a
  temp directory via `Deno.env.set("XDG_DATA_HOME", tmp)`, which
  `paths.ts` reads at call time. `deno.json`'s test task already grants
  `--allow-env --allow-read --allow-write`.

Existing `apt-decoder.test.ts`, `recorder.test.ts`, and `events.test.ts`
must continue to pass unchanged.

The repo has no UI test framework, and adding one is out of scope. UI
verification is manual, in the browser preview, against the 9 real
recordings already on disk.

## Verification limits

`rtl_fm`, `sox`, and `satdump` are all installed on the development
machine, but whether an RTL-SDR dongle is attached is unknown, and a
satellite pass cannot be produced on demand.

Fully verifiable here: layout, theme, recordings list/open/delete, image
stage zoom and channel modes, save, error states, and the decoder's sync
metric driven by the synthetic test signal.

**Not verifiable here**: the live signal meters and live decode against a
real transmission. `apt-signal` can be exercised via the synthetic
decoder path, but real-world level and sync behavior during an actual
pass needs confirmation by the user on the air.
