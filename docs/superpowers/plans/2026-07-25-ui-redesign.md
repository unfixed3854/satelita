# satelita UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild satelita's single-route UI as a dark instrument panel with a left control rail and an image stage, adding live signal metering, a zoomable APT channel viewer, and a recordings library.

**Architecture:** `src/routes/index.tsx` currently owns SSE plumbing, canvas rasterization, layout, and controls in 244 lines. It is decomposed into a typed SSE hook (`src/hooks/use-recorder-events.ts`), five presentational components under `src/components/`, and a pure geometry/formatting module (`src/lib/apt.ts`). On the server, the existing `AptDecoder` gains a sync-lock readout it already computes but discards, `recorder.ts` broadcasts a new throttled `apt-signal` event, and a new `recordings.ts` module lists/deletes/serves past passes from disk.

**Tech Stack:** TanStack Start (React 19 + Vite 8), Deno runtime + `deno desktop`, Tailwind v4, shadcn/ui on Base UI (`style: base-nova`), lucide-react, `deno test` with `@std/assert`.

## Global Constraints

- **No new npm dependencies.** `package.json` must gain no entries. The one new UI primitive (`Slider`) comes from the shadcn CLI and is built on `@base-ui/react`, already installed.
- **Dark-only.** `<html className="dark">` in `src/routes/__root.tsx` stays — shadcn components use `dark:` variants. `:root` and `.dark` receive identical palettes.
- **Red is reserved** for the recording indicator, the Stop button, and errors. Green (`--signal`) means locked/live.
- **Numeric readouts** use `font-mono tabular-nums` so digits do not jitter.
- **Server imports use explicit `.ts` extensions** (Deno requirement, e.g. `./recordings.ts`). Client imports use the `@/` alias with no extension (`@/lib/apt`). `tsconfig.json` maps `@/*` → `./src/*`.
- **Existing tests must keep passing**: `src/server/apt-decoder.test.ts`, `recorder.test.ts`, `events.test.ts`.
- Test command: `deno task test`. Build/typecheck: `npm run build`.

## Spec refinement adopted in this plan

The spec described `apt-final` continuing to carry `{ data_url }` and the client holding a `finalUrl`. This plan changes `apt-final` to carry **`{ id }`** — the recording directory name — instead.

Rationale: the payload is an ~875 KB PNG, and base64 through SSE inflates it by ~33% for a file the client can fetch (and cache) from the new image route. More importantly it unifies the finished-image path: a just-finished pass and a reopened pass both render through `/api/recordings/:id/:image`, so the A/B toggle always uses satdump's real `APT-A.png`/`APT-B.png` instead of cropping in one case and not the other. Everything else in the spec is unchanged, including the fallback behavior when no final image is produced.

---

### Task 1: Instrument theme, APT geometry module, and test wiring

**Files:**
- Modify: `src/app.css:51-118` (palette), `src/app.css:8-49` (`@theme inline`)
- Create: `src/lib/apt.ts`
- Create: `src/lib/apt.test.ts`
- Modify: `deno.json:9` (test task), `tsconfig.json:3` (exclude)

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `APT_LINE_WIDTH: number`, `CHANNEL_FRACTIONS: Record<ChannelMode, {start: number, width: number}>`, `type ChannelMode = "both" | "a" | "b"`, `fmtElapsed(totalSecs: number): string`, `fmtBytes(bytes: number): string`, `fmtClock(epochSecs: number): string`. CSS tokens `--color-signal`, `--color-signal-dim`, `--color-signal-warn`, `--color-grid`.

- [ ] **Step 1: Widen the test scope so `src/lib` tests run and don't break the build**

`src/lib/apt.test.ts` imports `@std/assert`, a JSR specifier that `tsc --noEmit` (moduleResolution: Bundler) cannot resolve. The existing tsconfig already excludes `src/server/**/*.test.ts` for exactly this reason; widen it to all test files.

In `tsconfig.json`, change line 3 from:

```json
  "exclude": ["node_modules", "src/server/**/*.test.ts"],
```

to:

```json
  "exclude": ["node_modules", "src/**/*.test.ts"],
```

In `deno.json`, change the `test` task from:

```json
    "test": "deno test --allow-env --allow-read --allow-write src/server/"
```

to:

```json
    "test": "deno test --allow-env --allow-read --allow-write src/server/ src/lib/"
```

- [ ] **Step 2: Write the failing test for the formatters and channel geometry**

Create `src/lib/apt.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { APT_LINE_WIDTH, CHANNEL_FRACTIONS, fmtBytes, fmtElapsed } from "./apt.ts";

Deno.test("fmtElapsed renders m:ss and pads seconds", () => {
  assertEquals(fmtElapsed(0), "0:00");
  assertEquals(fmtElapsed(9), "0:09");
  assertEquals(fmtElapsed(65), "1:05");
  assertEquals(fmtElapsed(600), "10:00");
  assertEquals(fmtElapsed(-5), "0:00");
});

Deno.test("fmtBytes scales and keeps one decimal below 10", () => {
  assertEquals(fmtBytes(512), "512 B");
  assertEquals(fmtBytes(1024), "1.0 KB");
  assertEquals(fmtBytes(13_213_696), "12.6 MB");
  assertEquals(fmtBytes(305_000_000), "291 MB");
});

Deno.test("channel fractions split the line in half", () => {
  assertEquals(APT_LINE_WIDTH, 2080);
  assertEquals(CHANNEL_FRACTIONS.both, { start: 0, width: 1 });
  assertEquals(CHANNEL_FRACTIONS.a, { start: 0, width: 0.5 });
  assertEquals(CHANNEL_FRACTIONS.b, { start: 0.5, width: 0.5 });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `deno task test`
Expected: FAIL — `Module not found "file:///…/src/lib/apt.ts"`

- [ ] **Step 4: Create the APT module**

Create `src/lib/apt.ts`:

```ts
// APT frame geometry and shared display formatters.
//
// A NOAA APT line is 2080 px: two identical 1040 px channel frames, each
// laid out [sync 39 | space 47 | video 909 | telemetry 45]. Channel A
// carries a visible/near-IR band, channel B a thermal-IR band.

export const APT_LINE_WIDTH = 2080;

/** Horizontal extent of each channel as a fraction of the full line.
 * Fractions rather than pixel offsets so the crop stays correct whatever
 * width the source canvas or image happens to be. */
export const CHANNEL_FRACTIONS = {
  both: { start: 0, width: 1 },
  a: { start: 0, width: 0.5 },
  b: { start: 0.5, width: 0.5 },
} as const;

export type ChannelMode = keyof typeof CHANNEL_FRACTIONS;

export function fmtElapsed(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : String(Math.round(v))} ${units[i]}`;
}

export function fmtClock(epochSecs: number): string {
  return new Date(epochSecs * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `deno task test`
Expected: PASS — all three new tests plus the existing decoder/recorder/events tests.

- [ ] **Step 6: Replace the palette in `src/app.css`**

Replace the entire `:root { … }` block (lines 51-84) and the entire `.dark { … }` block (lines 86-118) with the two blocks below. Both selectors get identical values — the app is dark-only, and a second palette would be dead weight that silently drifts.

```css
:root,
.dark {
  --background: oklch(0.145 0.008 240);
  --foreground: oklch(0.96 0.005 240);
  --card: oklch(0.19 0.008 240);
  --card-foreground: oklch(0.96 0.005 240);
  --popover: oklch(0.2 0.008 240);
  --popover-foreground: oklch(0.96 0.005 240);
  --primary: oklch(0.8 0.19 148);
  --primary-foreground: oklch(0.16 0.03 148);
  --secondary: oklch(0.26 0.008 240);
  --secondary-foreground: oklch(0.96 0.005 240);
  --muted: oklch(0.24 0.008 240);
  --muted-foreground: oklch(0.68 0.008 240);
  --accent: oklch(0.26 0.01 148);
  --accent-foreground: oklch(0.9 0.1 148);
  --destructive: oklch(0.65 0.21 25);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 14%);
  --ring: oklch(0.8 0.19 148 / 60%);
  --radius: 0.5rem;

  /* Instrument tokens */
  --signal: oklch(0.8 0.19 148);
  --signal-dim: oklch(0.46 0.09 148);
  --signal-warn: oklch(0.8 0.16 75);
  --grid: oklch(1 0 0 / 6%);

  --chart-1: var(--signal);
  --chart-2: var(--signal-warn);
  --chart-3: oklch(0.439 0 0);
  --chart-4: oklch(0.371 0 0);
  --chart-5: oklch(0.269 0 0);

  --sidebar: oklch(0.17 0.008 240);
  --sidebar-foreground: oklch(0.96 0.005 240);
  --sidebar-primary: oklch(0.8 0.19 148);
  --sidebar-primary-foreground: oklch(0.16 0.03 148);
  --sidebar-accent: oklch(0.26 0.01 148);
  --sidebar-accent-foreground: oklch(0.9 0.1 148);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.8 0.19 148 / 60%);
}
```

- [ ] **Step 7: Expose the instrument tokens to Tailwind**

In `src/app.css`, inside the existing `@theme inline { … }` block, add these four lines directly after `--font-sans: 'Geist Variable', sans-serif;`:

```css
  --color-signal: var(--signal);
  --color-signal-dim: var(--signal-dim);
  --color-signal-warn: var(--signal-warn);
  --color-grid: var(--grid);
```

This makes `text-signal`, `bg-signal-dim`, `border-grid` etc. available as Tailwind utilities.

- [ ] **Step 8: Verify the theme renders**

Start the preview and confirm the palette applied. The existing UI is still the old layout — that is expected; this task only changes colors.

Run `preview_start` with `{name: "dev"}`, then `javascript_tool`:

```js
getComputedStyle(document.body).backgroundColor
```

Expected: a near-black color, clearly darker than the previous `rgb(37, 37, 37)`. Do not assert an exact triple — the browser's oklch conversion is what it is.

Then confirm the accent token resolves (this one is exact — it is the literal declared value):

```js
getComputedStyle(document.documentElement).getPropertyValue('--signal').trim()
```

Expected: `oklch(0.8 0.19 148)`

- [ ] **Step 9: Commit**

```bash
git add src/app.css src/lib/apt.ts src/lib/apt.test.ts deno.json tsconfig.json
git commit -m "feat: add instrument palette and APT geometry module

Replaces the stock nova grayscale with a dark signal-green instrument
palette applied identically to :root and .dark, and adds src/lib/apt.ts
for APT channel geometry and display formatters. Widens the test task
and tsconfig test exclusion to cover src/lib."
```

---

### Task 2: Sync-lock metric in the decoder

**Files:**
- Modify: `src/server/apt-decoder.ts` (add fields, extend `findLineStart`)
- Modify: `src/server/apt-decoder.test.ts` (append one test)

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `AptDecoder.lastSyncScore: number` (0..1) and `AptDecoder.lastSyncRaw: number` (correlation in units of pixel std-dev). Task 3 reads `lastSyncScore`.

**Background:** `findLineStart()` already computes `bestScore = Σ t_k · (pixbuf[o+k] − mean)` over `SYNC_TPL = 28` taps with `t_k = ±1`, then throws it away. Dividing by `SYNC_TPL · std` gives the sync amplitude in standard deviations, which is the raw lock quality.

- [ ] **Step 1: Write the failing calibration test**

Append to `src/server/apt-decoder.test.ts`. It reuses `testImage` and `synthAudio` already defined at the top of that file. The noise generator is a seeded LCG, not `Math.random`, so this test can never flake.

```ts
function noiseAudio(length: number): Float32Array {
  const out = new Float32Array(length);
  let seed = 12345;
  for (let i = 0; i < length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (seed / 0x7fffffff) * 2 - 1;
  }
  return out;
}

function runDecoder(audio: Float32Array, fs: number): AptDecoder {
  const dec = new AptDecoder(fs);
  const chunkSize = 8192;
  for (let i = 0; i < audio.length; i += chunkSize) {
    dec.process(audio.subarray(i, Math.min(i + chunkSize, audio.length)));
  }
  return dec;
}

Deno.test("sync lock separates APT from noise", () => {
  const fs = 60_000;
  const img = testImage(APT_LINE_WIDTH, 40);
  const aptAudio = synthAudio(img, APT_LINE_WIDTH, fs);

  const apt = runDecoder(aptAudio, fs);
  const noise = runDecoder(noiseAudio(aptAudio.length), fs);

  // Printed so the two normalization constants can be calibrated from
  // measurement rather than from theory.
  console.log(
    `sync raw: apt=${apt.lastSyncRaw.toFixed(3)} noise=${noise.lastSyncRaw.toFixed(3)}`,
  );
  console.log(
    `sync score: apt=${apt.lastSyncScore.toFixed(3)} noise=${noise.lastSyncScore.toFixed(3)}`,
  );

  assert(apt.lastSyncScore > 0.5, `APT sync score too low: ${apt.lastSyncScore}`);
  assert(noise.lastSyncScore < 0.2, `noise sync score too high: ${noise.lastSyncScore}`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test`
Expected: FAIL — TypeScript error, `Property 'lastSyncRaw' does not exist on type 'AptDecoder'`.

- [ ] **Step 3: Add the sync readout to the decoder**

In `src/server/apt-decoder.ts`, add two module constants after the existing `const TAU = Math.PI * 2;` (line 18):

```ts
// Sync-lock normalization. Correlating 28 random taps and taking the best
// of 65 offsets leaves a noise floor well above zero, so it is subtracted
// rather than assumed to be 0. Both values are calibrated from the
// measurements printed by "sync lock separates APT from noise".
const SYNC_NOISE_FLOOR = 0.5;
const SYNC_FULL_LOCK = 1.5;
```

Add two public fields next to the existing `linesOut = 0;` (line 40):

```ts
  /** Sync-A correlation from the most recent line alignment, in units of
   * pixel standard deviation. Exposed for calibration. */
  lastSyncRaw = 0;
  /** Normalized 0..1 lock quality: 0 is indistinguishable from noise,
   * 1 is a clean sync-A pulse train. */
  lastSyncScore = 0;
```

Replace the tail of `findLineStart()` — change:

```ts
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }
    return best;
  }
```

to:

```ts
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }

    const std = Math.sqrt(Math.max(this.variance, 1e-9));
    this.lastSyncRaw = bestScore / (SYNC_TPL * std);
    this.lastSyncScore = Math.min(
      1,
      Math.max(0, (this.lastSyncRaw - SYNC_NOISE_FLOOR) / (SYNC_FULL_LOCK - SYNC_NOISE_FLOOR)),
    );
    return best;
  }
```

- [ ] **Step 4: Run the test and calibrate the constants**

Run: `deno task test`

Read the two `console.log` lines. **If the assertions fail, adjust `SYNC_NOISE_FLOOR` and `SYNC_FULL_LOCK` to match the measured raw values** — set `SYNC_NOISE_FLOOR` slightly above the measured noise raw value and `SYNC_FULL_LOCK` at or slightly below the measured APT raw value, then re-run. Do not weaken the assertions to fit the constants; the whole point of the metric is that these two populations separate cleanly.

Expected once calibrated: PASS, with the APT score near 1.0 and the noise score near 0.0.

- [ ] **Step 5: Verify existing decoder behavior is unchanged**

Run: `deno task test`
Expected: `reconstructs synthetic APT image` still PASSES with correlation > 0.85. `findLineStart` returns the same `best` offset as before — only the two new fields were added.

- [ ] **Step 6: Commit**

```bash
git add src/server/apt-decoder.ts src/server/apt-decoder.test.ts
git commit -m "feat: expose normalized sync-lock quality from the APT decoder

findLineStart already computed a sync-A template correlation and
discarded it. Normalize it against the pixel standard deviation and the
measured noise floor so the UI can distinguish a locked signal from
recorded noise while a pass is still running."
```

---

### Task 3: Signal telemetry broadcast and a distinct `decoding` state

**Files:**
- Modify: `src/server/recorder.ts` (export `CAPTURE_RATE`, add `chunkLevel`, extend `readerLoop`, change `stopRecording`, add `id` to `Session`)
- Modify: `src/server/recorder.test.ts` (append one test)

**Interfaces:**
- Consumes: `AptDecoder.lastSyncScore` (Task 2)
- Produces: `CAPTURE_RATE: number` (Task 4 imports it), `chunkLevel(samples: Float32Array): { peak: number; rms: number }`. New SSE events consumed by Task 6:
  - `apt-signal` → `{ peak: number; rms: number; sync: number; lines: number; elapsed_secs: number }`
  - `apt-status` → gains `state: "decoding"`
  - `apt-final` → payload changes from `{ data_url }` to `{ id: string }`

- [ ] **Step 1: Write the failing test for the level helper**

Append to `src/server/recorder.test.ts`, and add `chunkLevel` to the existing import on line 2:

```ts
Deno.test("chunkLevel reports peak magnitude and RMS", () => {
  const { peak, rms } = chunkLevel(Float32Array.from([0.5, -0.8, 0.1, -0.2]));
  assertEquals(peak, 0.8);
  const expected = Math.sqrt((0.25 + 0.64 + 0.01 + 0.04) / 4);
  assertEquals(Math.abs(rms - expected) < 1e-9, true);
});

Deno.test("chunkLevel handles an empty chunk without dividing by zero", () => {
  const { peak, rms } = chunkLevel(new Float32Array(0));
  assertEquals(peak, 0);
  assertEquals(rms, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test`
Expected: FAIL — `chunkLevel` is not exported from `./recorder.ts`.

- [ ] **Step 3: Add `chunkLevel` and export `CAPTURE_RATE`**

In `src/server/recorder.ts`, change line 17 from:

```ts
const CAPTURE_RATE = 60_000; // rtl_fm FM-demod output rate (also the DSP rate)
```

to:

```ts
/** rtl_fm FM-demod output rate — also the DSP rate, and the divisor that
 * turns a recording's signal.raw byte count back into its duration. */
export const CAPTURE_RATE = 60_000;
```

Add this function directly after `bytesToSamples` (after line 75):

```ts
/** Peak magnitude and RMS of a sample chunk, for the UI's level meter.
 * Peak is what reveals clipping; RMS is what tracks the pass envelope. */
export function chunkLevel(samples: Float32Array): { peak: number; rms: number } {
  let peak = 0;
  let sumSq = 0;
  for (const s of samples) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
    sumSq += s * s;
  }
  return { peak, rms: samples.length > 0 ? Math.sqrt(sumSq / samples.length) : 0 };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno task test`
Expected: PASS.

- [ ] **Step 5: Broadcast `apt-signal` from the reader loop**

In `readerLoop`, add a throttle variable next to `let lastStatus = -1;` (line 96):

```ts
  let lastSignalMs = 0;
```

Then, inside the `while (true)` loop, insert this block immediately after the existing `if (lines.length > 0) { … }` block and before `const elapsed = nowSecs() - startEpoch;`:

```ts
      // 4 Hz is the fastest the meter strips can show; rtl_fm delivers
      // chunks faster than that.
      const nowMs = Date.now();
      if (nowMs - lastSignalMs >= 250) {
        lastSignalMs = nowMs;
        const { peak, rms } = chunkLevel(samples);
        broadcast("apt-signal", {
          peak,
          rms,
          sync: decoder.lastSyncScore,
          lines: decoder.linesOut,
          elapsed_secs: nowSecs() - startEpoch,
        });
      }
```

- [ ] **Step 6: Add the recording id to the session and emit the `decoding` state**

`stopRecording` currently emits `state: "stopped"` twice — once for "Running final decode…" and again when satdump returns — so the UI cannot tell "still working" from "finished" without matching on message text.

In the `Session` interface (line 77), add an `id` field:

```ts
interface Session {
  rtl: Deno.ChildProcess;
  reader: Promise<void>;
  runDir: string;
  id: string;
  sat: string;
  startEpoch: number;
}
```

In `startRecording`, change the `runDir` construction (line 185) from:

```ts
    const runDir = recordingsDir(`noaa${sat}-${startEpoch}`);
```

to:

```ts
    const id = `noaa${sat}-${startEpoch}`;
    const runDir = recordingsDir(id);
```

and change the session assignment (line 207) from:

```ts
    session = { rtl, reader, runDir, sat, startEpoch };
```

to:

```ts
    session = { rtl, reader, runDir, id, sat, startEpoch };
```

In `stopRecording`, change line 232 from:

```ts
  emitStatus("stopped", "Running final decode…", elapsed);
```

to:

```ts
  emitStatus("decoding", "Running final decode…", elapsed);
```

- [ ] **Step 7: Change `apt-final` to carry the recording id**

The client can fetch the PNG from the image route added in Task 5 and let the browser cache it, instead of receiving ~1.2 MB of base64 over SSE. In `stopRecording`, change the async block (lines 234-240) from:

```ts
  (async () => {
    const png = await finalDecode(current.runDir, current.sat, current.startEpoch);
    if (png) {
      broadcast("apt-final", { data_url: `data:image/png;base64,${encodeBase64(png)}` });
    }
    emitStatus("stopped", `Stopped. Files in ${current.runDir}`, elapsed);
  })();
```

to:

```ts
  (async () => {
    const png = await finalDecode(current.runDir, current.sat, current.startEpoch);
    if (png) {
      // Just the id — the client fetches the image from
      // /api/recordings/:id/:image, which the browser can cache.
      broadcast("apt-final", { id: current.id });
    }
    emitStatus("stopped", `Stopped. Files in ${current.runDir}`, elapsed);
  })();
```

`finalDecode` is still called and its return value still gates the event, because a `null` return means satdump produced no image and there is nothing for the client to fetch.

- [ ] **Step 8: Remove the now-unused base64 encoder if nothing else uses it**

Run: `grep -n 'encodeBase64' src/server/recorder.ts`

`encodeBase64` is still used by the `apt-line` broadcast, so it stays. Confirm the grep shows the definition plus the `apt-line` call site and nothing else — if it shows an orphaned definition, delete it.

- [ ] **Step 9: Run all tests and the typecheck**

Run: `deno task test`
Expected: PASS — all decoder, recorder, and events tests.

Run: `npm run build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 10: Commit**

```bash
git add src/server/recorder.ts src/server/recorder.test.ts
git commit -m "feat: broadcast live signal telemetry and a distinct decoding state

Adds a 4 Hz apt-signal event carrying peak, RMS, and sync-lock so the UI
can show pass shape and whether gain is set correctly. stopRecording now
emits state 'decoding' for the satdump phase instead of a second
'stopped', and apt-final carries the recording id rather than an
875 KB PNG base64-inflated through SSE."
```

---

### Task 4: Recordings server module

**Files:**
- Create: `src/server/recordings.ts`
- Create: `src/server/recordings.test.ts`
- Modify: `src/server/functions.ts` (add two server functions)

**Interfaces:**
- Consumes: `CAPTURE_RATE` from `./recorder.ts` (Task 3), `appDataDir` from `./paths.ts`
- Produces:
  - `interface Recording { id, satellite, startedAt, durationSecs, bytes, images, complete }`
  - `isValidRecordingId(id: string): boolean`
  - `isFinalImage(name: string): name is FinalImage`
  - `recordingsRoot(): string`
  - `listRecordings(): Promise<Recording[]>`
  - `deleteRecording(id: string): Promise<void>`
  - `readFinalImage(id: string, image: string): Promise<Uint8Array | null>` (Task 5 uses this)
  - `listRecordingsFn`, `deleteRecordingFn` server functions (Tasks 9 and 11 use these)

- [ ] **Step 1: Write the failing tests**

Create `src/server/recordings.test.ts`. The temp-root helper sets `XDG_DATA_HOME`, `HOME`, and `APPDATA` so `appDataDir()` resolves under the temp directory on every platform, and asserts the resolved root really is under the temp directory **before writing anything** — without that guard, a resolution surprise would have the test operating on the user's real recordings.

```ts
/// <reference lib="deno.ns" />
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  deleteRecording,
  isFinalImage,
  isValidRecordingId,
  listRecordings,
  readFinalImage,
  recordingsRoot,
} from "./recordings.ts";

const ENV_KEYS = ["XDG_DATA_HOME", "HOME", "APPDATA"] as const;

async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const tmp = await Deno.makeTempDir();
  const saved = ENV_KEYS.map((k) => [k, Deno.env.get(k)] as const);
  for (const k of ENV_KEYS) Deno.env.set(k, tmp);
  try {
    const root = recordingsRoot();
    // Guard: never let a resolution surprise point the test at real data.
    assert(root.startsWith(tmp), `recordingsRoot() escaped the temp dir: ${root}`);
    await Deno.mkdir(root, { recursive: true });
    await fn(root);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    await Deno.remove(tmp, { recursive: true });
  }
}

/** Build a recording directory. `rawBytes` sets signal.raw's size, which
 * is what duration is derived from. */
async function makeRecording(
  root: string,
  id: string,
  opts: { rawBytes?: number; dataset?: unknown; images?: string[] } = {},
): Promise<void> {
  const dir = `${root}/${id}`;
  await Deno.mkdir(`${dir}/decode`, { recursive: true });
  await Deno.writeFile(`${dir}/signal.raw`, new Uint8Array(opts.rawBytes ?? 0));
  if (opts.dataset !== undefined) {
    await Deno.writeTextFile(`${dir}/decode/dataset.json`, JSON.stringify(opts.dataset));
  }
  for (const name of opts.images ?? []) {
    await Deno.writeFile(`${dir}/decode/${name}.png`, new Uint8Array(16));
  }
}

Deno.test("isValidRecordingId accepts run ids and rejects traversal", () => {
  assertEquals(isValidRecordingId("noaa15-1784827259"), true);
  assertEquals(isValidRecordingId("noaa19-1"), true);
  assertEquals(isValidRecordingId(".."), false);
  assertEquals(isValidRecordingId("../../etc"), false);
  assertEquals(isValidRecordingId("noaa15-1784827259/../.."), false);
  assertEquals(isValidRecordingId("/etc/passwd"), false);
  assertEquals(isValidRecordingId("noaa15"), false);
  assertEquals(isValidRecordingId(""), false);
});

Deno.test("isFinalImage allows only the three satdump outputs", () => {
  assertEquals(isFinalImage("raw_sync"), true);
  assertEquals(isFinalImage("APT-A"), true);
  assertEquals(isFinalImage("APT-B"), true);
  assertEquals(isFinalImage("raw_unsync"), false);
  assertEquals(isFinalImage("../../../etc/passwd"), false);
  assertEquals(isFinalImage("APT-A.png"), false);
});

Deno.test("listRecordings returns an empty list when nothing was ever recorded", async () => {
  await withTempRoot(async (root) => {
    await Deno.remove(root, { recursive: true });
    assertEquals(await listRecordings(), []);
  });
});

Deno.test("listRecordings prefers dataset.json and derives duration from raw size", async () => {
  await withTempRoot(async (root) => {
    // 110 s at 60 kHz s16 mono = 110 * 60000 * 2 bytes
    await makeRecording(root, "noaa15-1784827259", {
      rawBytes: 110 * 60_000 * 2,
      dataset: { satellite: "NOAA-15", timestamp: 1784827259.0 },
      images: ["raw_sync", "APT-A", "APT-B"],
    });

    const [rec] = await listRecordings();
    assertEquals(rec.id, "noaa15-1784827259");
    assertEquals(rec.satellite, "NOAA-15");
    assertEquals(rec.startedAt, 1784827259);
    assertEquals(rec.durationSecs, 110);
    assertEquals(rec.images, ["raw_sync", "APT-A", "APT-B"]);
    assertEquals(rec.complete, true);
    assert(rec.bytes > 110 * 60_000 * 2, "bytes should include decode/ contents");
  });
});

Deno.test("listRecordings falls back to the directory name and flags aborted runs", async () => {
  await withTempRoot(async (root) => {
    // Aborted run: empty decode/, no dataset.json, no images.
    await makeRecording(root, "noaa19-1784913812", { rawBytes: 60_000 * 2 * 13 });

    const [rec] = await listRecordings();
    assertEquals(rec.satellite, "NOAA-19");
    assertEquals(rec.startedAt, 1784913812);
    assertEquals(rec.durationSecs, 13);
    assertEquals(rec.images, []);
    assertEquals(rec.complete, false);
  });
});

Deno.test("listRecordings sorts newest first and skips foreign directories", async () => {
  await withTempRoot(async (root) => {
    await makeRecording(root, "noaa15-1000");
    await makeRecording(root, "noaa19-3000");
    await makeRecording(root, "noaa18-2000");
    await Deno.mkdir(`${root}/not-a-recording`, { recursive: true });

    const ids = (await listRecordings()).map((r) => r.id);
    assertEquals(ids, ["noaa19-3000", "noaa18-2000", "noaa15-1000"]);
  });
});

Deno.test("deleteRecording removes the directory", async () => {
  await withTempRoot(async (root) => {
    await makeRecording(root, "noaa15-1784827259", { images: ["raw_sync"] });
    await deleteRecording("noaa15-1784827259");
    assertEquals(await listRecordings(), []);
  });
});

Deno.test("deleteRecording refuses invalid ids before touching the filesystem", async () => {
  await withTempRoot(async (root) => {
    await makeRecording(root, "noaa15-1784827259");
    for (const bad of ["..", "../..", "noaa15-1784827259/../..", "/etc", ""]) {
      await assertRejects(() => deleteRecording(bad), Error, "Invalid recording id");
    }
    // The real recording is untouched.
    assertEquals((await listRecordings()).length, 1);
  });
});

Deno.test("readFinalImage returns bytes for allowed names and null otherwise", async () => {
  await withTempRoot(async (root) => {
    await makeRecording(root, "noaa15-1784827259", { images: ["APT-A"] });

    const ok = await readFinalImage("noaa15-1784827259", "APT-A");
    assertEquals(ok?.length, 16);

    assertEquals(await readFinalImage("noaa15-1784827259", "APT-B"), null);
    assertEquals(await readFinalImage("noaa15-1784827259", "raw_unsync"), null);
    assertEquals(await readFinalImage("..", "APT-A"), null);
    assertEquals(await readFinalImage("noaa15-1784827259", "../../../etc/passwd"), null);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno task test`
Expected: FAIL — `Module not found "file:///…/src/server/recordings.ts"`

- [ ] **Step 3: Create the recordings module**

Create `src/server/recordings.ts`:

```ts
// Browsing and removing past APT recordings.
//
// Each run lives in its own directory under the app data dir, named
// `noaa<sat>-<startEpoch>` (see recorder.ts). A completed run's decode/
// holds satdump's output: raw_sync.png (2080 px, both channels plus sync
// and telemetry) and APT-A.png / APT-B.png (909 px video only), alongside
// dataset.json with the satellite name and start timestamp. An aborted
// run has an empty decode/ but still holds a signal.raw worth ~7 MB per
// minute, which is exactly what makes deletion worth offering.

import { appDataDir } from "./paths.ts";
import { CAPTURE_RATE } from "./recorder.ts";

const ID_PATTERN = /^noaa\d+-\d+$/;

/** The satdump outputs the UI is allowed to serve. */
export const FINAL_IMAGES = ["raw_sync", "APT-A", "APT-B"] as const;
export type FinalImage = (typeof FINAL_IMAGES)[number];

export interface Recording {
  id: string;
  satellite: string;
  startedAt: number;
  durationSecs: number;
  bytes: number;
  images: string[];
  complete: boolean;
}

/** Ids arrive from the client and are concatenated into filesystem paths,
 * so this is a correctness requirement, not defense in depth. */
export function isValidRecordingId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function isFinalImage(name: string): name is FinalImage {
  return (FINAL_IMAGES as readonly string[]).includes(name);
}

export function recordingsRoot(): string {
  return `${appDataDir()}/recordings`;
}

async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) total += await dirBytes(path);
    else if (entry.isFile) total += (await Deno.stat(path)).size;
  }
  return total;
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await Deno.stat(path)).size;
  } catch {
    return 0;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readRecording(root: string, id: string): Promise<Recording> {
  const dir = `${root}/${id}`;
  const [prefix, epoch] = id.split("-");

  let satellite = `NOAA-${prefix.slice("noaa".length)}`;
  let startedAt = Number(epoch);
  try {
    const meta = JSON.parse(await Deno.readTextFile(`${dir}/decode/dataset.json`));
    if (typeof meta.satellite === "string") satellite = meta.satellite;
    if (typeof meta.timestamp === "number") startedAt = Math.floor(meta.timestamp);
  } catch {
    // Aborted run, or satdump never wrote metadata — the directory name
    // already encodes both values.
  }

  const images: string[] = [];
  for (const name of FINAL_IMAGES) {
    if (await exists(`${dir}/decode/${name}.png`)) images.push(name);
  }

  return {
    id,
    satellite,
    startedAt,
    // Exact, not estimated: the capture is raw s16 mono at CAPTURE_RATE.
    durationSecs: Math.round((await fileSize(`${dir}/signal.raw`)) / (CAPTURE_RATE * 2)),
    bytes: await dirBytes(dir),
    images,
    complete: images.length > 0,
  };
}

export async function listRecordings(): Promise<Recording[]> {
  const root = recordingsRoot();

  const ids: string[] = [];
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.isDirectory && isValidRecordingId(entry.name)) ids.push(entry.name);
    }
  } catch {
    return []; // Nothing recorded yet.
  }

  const out = await Promise.all(ids.map((id) => readRecording(root, id)));
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out;
}

export async function deleteRecording(id: string): Promise<void> {
  if (!isValidRecordingId(id)) throw new Error(`Invalid recording id: ${id}`);
  await Deno.remove(`${recordingsRoot()}/${id}`, { recursive: true });
}

/** PNG bytes for one of a recording's final images, or null if the id or
 * image name is not allowed or the file does not exist. */
export async function readFinalImage(id: string, image: string): Promise<Uint8Array | null> {
  if (!isValidRecordingId(id) || !isFinalImage(image)) return null;
  try {
    return await Deno.readFile(`${recordingsRoot()}/${id}/decode/${image}.png`);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno task test`
Expected: PASS — all eight new recordings tests.

- [ ] **Step 5: Expose the server functions**

Append to `src/server/functions.ts`, and extend the existing import on line 2:

```ts
import { deleteRecording, listRecordings, type Recording } from "./recordings.ts";

export const listRecordingsFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<Recording[]> => {
    return await listRecordings();
  },
);

export const deleteRecordingFn = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    await deleteRecording(data.id);
  });
```

- [ ] **Step 6: Verify against the real recordings on disk**

This machine already has 9 real recordings totalling 291 MB. Confirm the module reads them correctly — **this is read-only, it does not delete anything**:

```bash
deno eval --allow-env --allow-read 'const m = await import("./src/server/recordings.ts"); console.table((await m.listRecordings()).map(({id,satellite,startedAt,durationSecs,bytes,complete}) => ({id,satellite,startedAt,durationSecs,bytes,complete})));'
```

Expected: 9 rows, newest first, satellites reading `NOAA-15`, plausible non-zero `durationSecs`, and at least one row with `complete: false` (the aborted runs with an empty `decode/`).

- [ ] **Step 7: Typecheck**

Run: `npm run build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add src/server/recordings.ts src/server/recordings.test.ts src/server/functions.ts
git commit -m "feat: add recordings listing and deletion

Scans the app data dir for past runs, preferring satdump's dataset.json
for metadata and falling back to the directory name so aborted runs still
list. Duration comes exactly from signal.raw's byte count. Recording ids
reach the filesystem from the client, so both deletion and image reads
validate them against a strict pattern first."
```

---

### Task 5: Recording image route

**Files:**
- Create: `src/routes/api/recordings.$id.$image.ts`
- Note: `src/routeTree.gen.ts` is git-ignored (see `.gitignore`) and regenerates when the dev server runs. Do not hand-edit it and do not try to commit it.

**Interfaces:**
- Consumes: `readFinalImage` from `../../server/recordings.ts` (Task 4)
- Produces: `GET /api/recordings/:id/:image` → `image/png` bytes, or 404. Tasks 10 and 11 build `src` URLs against this.

- [ ] **Step 1: Create the route**

Create `src/routes/api/recordings.$id.$image.ts`, following the handler shape already used by `src/routes/api/recorder-events.ts`:

```ts
import { createFileRoute } from "@tanstack/react-router";
import { readFinalImage } from "../../server/recordings.ts";

export const Route = createFileRoute("/api/recordings/$id/$image")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        // readFinalImage validates both params against an allowlist before
        // building any path.
        const png = await readFinalImage(params.id, params.image);
        if (!png) return new Response("Not found", { status: 404 });

        return new Response(png, {
          headers: {
            "Content-Type": "image/png",
            // A recording's id embeds its start epoch and its decoded
            // images never change, so this is safe to cache hard.
            "Cache-Control": "private, max-age=31536000, immutable",
          },
        });
      },
    },
  },
});
```

**If `params` is not supplied to the handler** (the existing `recorder-events.ts` route only destructures `request`, so this shape is unverified for path params), read them from the URL instead — the validation in `readFinalImage` is what matters, not where the strings come from:

```ts
      GET: async ({ request }) => {
        const parts = new URL(request.url).pathname.split("/");
        const image = parts.pop() ?? "";
        const id = parts.pop() ?? "";
        const png = await readFinalImage(id, image);
        // …unchanged from here
      },
```

- [ ] **Step 2: Verify the route serves a real image**

Start the dev server (`preview_start` with `{name: "dev"}`) — this also regenerates `src/routeTree.gen.ts`. Then, using a real id from Task 4's Step 6 output:

```bash
curl -s -o /tmp/apt-a.png -w '%{http_code} %{content_type} %{size_download}\n' http://localhost:1420/api/recordings/noaa15-1784827259/APT-A
```

Expected: `200 image/png 395331`

Confirm it is a real PNG of the expected dimensions:

```bash
python3 -c "import struct; d=open('/tmp/apt-a.png','rb').read(24); print(d[:8]==b'\x89PNG\r\n\x1a\n', struct.unpack('>II', d[16:24]))"
```

Expected: `True (909, 220)`

- [ ] **Step 3: Verify the validation actually rejects bad input**

```bash
for p in "../../../etc/passwd/APT-A" "noaa15-1784827259/raw_unsync" "noaa15-1784827259/..%2f..%2fetc%2fpasswd" "nope/APT-A"; do
  printf '%-50s ' "$p"
  curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:1420/api/recordings/$p"
done
```

Expected: every line reports `404` (or `400`). **No line may report `200`**, and no response may contain file contents from outside the recordings directory.

- [ ] **Step 4: Commit**

```bash
git add src/routes/api/recordings.\$id.\$image.ts
git commit -m "feat: serve recording images over HTTP

Lets the client fetch and cache satdump's raw_sync/APT-A/APT-B PNGs
instead of receiving them base64-inflated through the SSE stream. Both
path params are validated against allowlists in readFinalImage before any
path is built."
```

---

### Task 6: Recorder events hook

**Files:**
- Create: `src/hooks/use-recorder-events.ts`

**Interfaces:**
- Consumes: the SSE events from Task 3 (`apt-line`, `apt-signal`, `apt-status`, `apt-final`)
- Produces:
  - `type RecorderPhase = "idle" | "recording" | "decoding" | "stopped"`
  - `interface LinePayload { start_line: number; width: number; count: number; pixels_b64: string }`
  - `interface RecorderState { phase, message, elapsed, lines, finishedId, level, sync }`
  - `useRecorderEvents(onLine: (p: LinePayload) => void): { state: RecorderState; reset(): void; setPhase(p: RecorderPhase): void }`
  - `SIGNAL_HISTORY: number`

  Tasks 8, 9, 10, and 11 consume these names exactly.

- [ ] **Step 1: Create the hook**

Create `src/hooks/use-recorder-events.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";

export type RecorderPhase = "idle" | "recording" | "decoding" | "stopped";

export interface LinePayload {
  start_line: number;
  width: number;
  count: number;
  pixels_b64: string;
}

interface StatusPayload {
  state: string;
  message: string;
  elapsed_secs: number;
}

interface SignalPayload {
  peak: number;
  rms: number;
  sync: number;
  lines: number;
  elapsed_secs: number;
}

interface FinalPayload {
  id: string;
}

/** 90 s of history at the server's 4 Hz signal rate. */
export const SIGNAL_HISTORY = 360;

export interface RecorderState {
  phase: RecorderPhase;
  message: string;
  elapsed: number;
  lines: number;
  /** Id of the recording whose final decode just completed, if any. */
  finishedId: string | null;
  level: number[];
  sync: number[];
}

const INITIAL: RecorderState = {
  phase: "idle",
  message: "Idle — pick a satellite and press Record.",
  elapsed: 0,
  lines: 0,
  finishedId: null,
  level: [],
  sync: [],
};

function pushCapped(history: number[], value: number): number[] {
  const next = history.length >= SIGNAL_HISTORY
    ? history.slice(history.length - SIGNAL_HISTORY + 1)
    : history.slice();
  next.push(value);
  return next;
}

function toPhase(state: string): RecorderPhase {
  if (state === "recording" || state === "decoding" || state === "stopped") return state;
  return "idle";
}

/**
 * Subscribes to the recorder's SSE stream and exposes it as typed state.
 *
 * Decoded pixel data does not go through React state — it is handed to
 * `onLine` so the canvas can be written imperatively. Routing ~2 lines a
 * second of image data through setState would re-render the tree twice a
 * second to no purpose.
 */
export function useRecorderEvents(onLine: (payload: LinePayload) => void): {
  state: RecorderState;
  reset(): void;
  setPhase(phase: RecorderPhase): void;
} {
  const [state, setState] = useState<RecorderState>(INITIAL);

  // Held in a ref so an inline arrow from the caller does not tear down
  // and re-open the EventSource on every render.
  const onLineRef = useRef(onLine);
  useEffect(() => {
    onLineRef.current = onLine;
  });

  useEffect(() => {
    const source = new EventSource("/api/recorder-events");

    source.addEventListener("apt-line", (e) => {
      onLineRef.current(JSON.parse((e as MessageEvent).data) as LinePayload);
    });

    source.addEventListener("apt-signal", (e) => {
      const p = JSON.parse((e as MessageEvent).data) as SignalPayload;
      setState((prev) => ({
        ...prev,
        lines: p.lines,
        elapsed: p.elapsed_secs,
        level: pushCapped(prev.level, p.rms),
        sync: pushCapped(prev.sync, p.sync),
      }));
    });

    source.addEventListener("apt-status", (e) => {
      const p = JSON.parse((e as MessageEvent).data) as StatusPayload;
      setState((prev) => ({
        ...prev,
        phase: toPhase(p.state),
        message: p.message,
        elapsed: p.elapsed_secs,
      }));
    });

    source.addEventListener("apt-final", (e) => {
      const p = JSON.parse((e as MessageEvent).data) as FinalPayload;
      setState((prev) => ({ ...prev, finishedId: p.id }));
    });

    return () => source.close();
  }, []);

  const reset = useCallback(() => {
    setState((prev) => ({
      ...INITIAL,
      // Keep the message until the server sends the first real status, so
      // the status line does not flicker back to "Idle" mid-start.
      message: prev.message,
    }));
  }, []);

  const setPhase = useCallback((phase: RecorderPhase) => {
    setState((prev) => ({ ...prev, phase }));
  }, []);

  return { state, reset, setPhase };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: succeeds with no TypeScript errors. (The hook has no consumer yet — that is expected; Task 11 wires it in.)

- [ ] **Step 3: Commit**

```bash
git add src/hooks/use-recorder-events.ts
git commit -m "feat: add typed recorder events hook

Extracts SSE subscription and parsing out of the route component. Pixel
payloads bypass React state via an onLine callback so the canvas stays
imperative, and the callback is held in a ref so an inline arrow from the
caller cannot cause the stream to reconnect every render."
```

---

### Task 7: Capture panel with a gain slider

**Files:**
- Create: `src/components/ui/slider.tsx` (via shadcn CLI — do not hand-write)
- Create: `src/components/capture-panel.tsx`

**Interfaces:**
- Consumes: `Select*` from `@/components/ui/select`, `Button`, `Input`, `Label`, `Slider`
- Produces: `SATS: {id, label, freq}[]`, `CapturePanel` with props
  `{ sat, onSatChange, gain, onGainChange, device, onDeviceChange, recording, onStart, onStop }`. Task 11 renders it.

- [ ] **Step 1: Install the Slider primitive**

`Slider` is not yet in `src/components/ui/`. Install it the same way the other primitives were installed:

```bash
npx shadcn@latest add slider
```

- [ ] **Step 2: Verify no new npm dependency was added**

```bash
git diff --stat package.json package-lock.json
```

Expected: **no changes to `package.json`.** `Slider` is built on `@base-ui/react`, already a dependency. If `package.json` changed, revert it and investigate before continuing — the plan's global constraint is no new npm dependencies.

Also confirm the component landed:

```bash
ls src/components/ui/slider.tsx && grep -n '@base-ui/react' src/components/ui/slider.tsx
```

Expected: the file exists and imports from `@base-ui/react/slider`.

- [ ] **Step 3: Create the capture panel**

Create `src/components/capture-panel.tsx`:

```tsx
import { useRef } from "react";
import { Radio, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

export const SATS = [
  { id: "15", label: "NOAA-15", freq: "137.620 MHz" },
  { id: "18", label: "NOAA-18", freq: "137.9125 MHz" },
  { id: "19", label: "NOAA-19", freq: "137.100 MHz" },
];

/** Tuner gain range for the R820T/R820T2 front end rtl_fm drives. rtl_fm
 * snaps to the nearest supported step, so a continuous slider is fine. */
const GAIN_MIN = 0;
const GAIN_MAX = 49.6;

export interface CapturePanelProps {
  sat: string;
  onSatChange: (value: string) => void;
  gain: string;
  onGainChange: (value: string) => void;
  device: string;
  onDeviceChange: (value: string) => void;
  recording: boolean;
  onStart: () => void;
  onStop: () => void;
}

export function CapturePanel({
  sat,
  onSatChange,
  gain,
  onGainChange,
  device,
  onDeviceChange,
  recording,
  onStart,
  onStop,
}: CapturePanelProps) {
  const agc = gain === "agc";
  // Remembered so toggling AGC off restores the value you had dialled in.
  const lastManualGain = useRef("45");
  if (!agc) lastManualGain.current = gain;

  const numericGain = Number(agc ? lastManualGain.current : gain);
  const sliderValue = Number.isFinite(numericGain)
    ? Math.min(GAIN_MAX, Math.max(GAIN_MIN, numericGain))
    : 45;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sat" className="text-xs tracking-wide text-muted-foreground uppercase">
          Satellite
        </Label>
        <Select value={sat} onValueChange={(v) => v && onSatChange(v)} disabled={recording}>
          <SelectTrigger id="sat" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SATS.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                <span className="flex w-full items-center justify-between gap-3">
                  <span>{s.label}</span>
                  <span className="font-mono text-xs text-muted-foreground">{s.freq}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="gain" className="text-xs tracking-wide text-muted-foreground uppercase">
            Gain
          </Label>
          <button
            type="button"
            onClick={() => onGainChange(agc ? lastManualGain.current : "agc")}
            disabled={recording}
            className={cn(
              "rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-wide uppercase transition-colors",
              "disabled:cursor-not-allowed disabled:opacity-50",
              agc
                ? "border-signal/40 bg-signal/15 text-signal"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={agc}
          >
            AGC
          </button>
        </div>

        <div className="flex items-center gap-2">
          <Slider
            value={sliderValue}
            onValueChange={(v) => onGainChange(String(Array.isArray(v) ? v[0] : v))}
            min={GAIN_MIN}
            max={GAIN_MAX}
            step={0.1}
            disabled={recording || agc}
            aria-label="Gain in dB"
            className="flex-1"
          />
          <Input
            id="gain"
            value={agc ? "agc" : gain}
            onChange={(e) => onGainChange(e.target.value)}
            disabled={recording || agc}
            className="w-16 text-center font-mono tabular-nums"
            aria-label="Gain value"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="device" className="text-xs tracking-wide text-muted-foreground uppercase">
          Device
        </Label>
        <Input
          id="device"
          value={device}
          onChange={(e) => onDeviceChange(e.target.value)}
          disabled={recording}
          className="w-full font-mono tabular-nums"
        />
      </div>

      {!recording
        ? (
          <Button onClick={onStart} className="w-full gap-2">
            <Radio className="size-4" />
            Record
          </Button>
        )
        : (
          <Button variant="destructive" onClick={onStop} className="w-full gap-2">
            <Square className="size-4 fill-current" />
            Stop
          </Button>
        )}
    </div>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run build`
Expected: succeeds. **If the `Slider` value/onValueChange types differ** (Base UI's Slider may type `value` as `number | number[]`), adjust the two props to match the generated `src/components/ui/slider.tsx` signature — read that file rather than guessing.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/slider.tsx src/components/capture-panel.tsx
git commit -m "feat: add capture panel with a gain slider

Replaces the free-text gain field whose placeholder read '45 or agc' with
a slider over the R820T range, a numeric field for exact entry, and an
AGC toggle that restores the last manual value when switched off."
```

---

### Task 8: Signal panel

**Files:**
- Create: `src/components/signal-panel.tsx`

**Interfaces:**
- Consumes: `SIGNAL_HISTORY` from `@/hooks/use-recorder-events` (Task 6), `--color-signal*` / `--color-grid` tokens (Task 1)
- Produces: `SignalPanel` with props `{ level: number[]; sync: number[]; lines: number; recording: boolean }`. Task 11 renders it.

- [ ] **Step 1: Create the signal panel**

Create `src/components/signal-panel.tsx`. The strip primitive lives in this file — it is small and has no other consumer.

```tsx
import { useEffect, useRef } from "react";

import { SIGNAL_HISTORY } from "@/hooks/use-recorder-events";

/** Peak level above which the front end is effectively clipping and the
 * pass is being quietly ruined. */
const CLIP_THRESHOLD = 0.95;

function readToken(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** A scrolling history strip. Values are 0..1, oldest first. */
function Strip({
  values,
  color,
  label,
  readout,
  warn,
}: {
  values: number[];
  color: string;
  label: string;
  readout: string;
  warn: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    if (cssWidth === 0 || cssHeight === 0) return;

    if (canvas.width !== cssWidth * dpr || canvas.height !== cssHeight * dpr) {
      canvas.width = cssWidth * dpr;
      canvas.height = cssHeight * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    // Gridlines at 25/50/75%.
    ctx.strokeStyle = readToken("--grid", "rgba(255,255,255,0.06)");
    ctx.lineWidth = 1;
    for (const f of [0.25, 0.5, 0.75]) {
      const y = Math.round(cssHeight * f) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(cssWidth, y);
      ctx.stroke();
    }

    if (values.length === 0) return;

    // Always scale to the full history window so the trace scrolls in
    // from the right rather than stretching as samples accumulate.
    const step = cssWidth / SIGNAL_HISTORY;
    const x0 = cssWidth - values.length * step;
    const yFor = (v: number) => cssHeight - Math.min(1, Math.max(0, v)) * cssHeight;

    ctx.beginPath();
    ctx.moveTo(x0, cssHeight);
    values.forEach((v, i) => ctx.lineTo(x0 + i * step, yFor(v)));
    ctx.lineTo(x0 + (values.length - 1) * step, cssHeight);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.22;
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = x0 + i * step;
      if (i === 0) ctx.moveTo(x, yFor(v));
      else ctx.lineTo(x, yFor(v));
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [values, color]);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</span>
        <span
          className={`font-mono text-[11px] tabular-nums ${
            warn ? "text-signal-warn" : "text-muted-foreground"
          }`}
        >
          {readout}
        </span>
      </div>
      <canvas ref={canvasRef} className="h-10 w-full rounded border border-border bg-black/30" />
    </div>
  );
}

export interface SignalPanelProps {
  level: number[];
  sync: number[];
  lines: number;
  recording: boolean;
}

export function SignalPanel({ level, sync, lines, recording }: SignalPanelProps) {
  const latestLevel = level.at(-1) ?? 0;
  const latestSync = sync.at(-1) ?? 0;
  const clipping = latestLevel >= CLIP_THRESHOLD;

  const signalColor = readToken("--signal", "#4ade80");
  const warnColor = readToken("--signal-warn", "#fbbf24");
  const dimColor = readToken("--signal-dim", "#2f5f43");

  return (
    <div className="flex flex-col gap-3">
      <Strip
        values={level}
        color={clipping ? warnColor : signalColor}
        label="Level"
        readout={clipping ? "CLIP" : latestLevel.toFixed(2)}
        warn={clipping}
      />
      <Strip
        values={sync}
        color={latestSync > 0.5 ? signalColor : dimColor}
        label="Sync lock"
        readout={`${Math.round(latestSync * 100)}%`}
        warn={false}
      />
      <div className="flex items-baseline justify-between border-t border-border pt-2">
        <span className="text-[10px] tracking-wide text-muted-foreground uppercase">Lines</span>
        <span
          className={`font-mono text-sm tabular-nums ${recording ? "text-signal" : "text-foreground"}`}
        >
          {lines}
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/signal-panel.tsx
git commit -m "feat: add rolling signal history strips

Level and sync-lock render as 90 s scrolling traces rather than
instantaneous bars, so a pass's rise and fall is visible and a gain change
can be judged against what preceded it. Peak at or above 0.95 flips the
level strip to the warning colour and reads CLIP."
```

---

### Task 9: Recordings panel

**Files:**
- Create: `src/components/recordings-panel.tsx`

**Interfaces:**
- Consumes: `Recording` type from `@/server/recordings` (Task 4), `fmtBytes` / `fmtClock` / `fmtElapsed` from `@/lib/apt` (Task 1)
- Produces: `RecordingsPanel` with props `{ recordings, selectedId, openDisabled, onOpen, onDelete }`. Task 11 renders it.

Note: importing only the `Recording` **type** from a server module is safe — `import type` is erased at build time and pulls no Deno APIs into the client bundle. It must be written as `import type`, not a value import.

- [ ] **Step 1: Create the recordings panel**

Create `src/components/recordings-panel.tsx`. Deletion uses a two-step inline confirm rather than a dialog, so no additional shadcn component is needed.

```tsx
import { useState } from "react";
import { HardDrive, ImageOff, Trash2 } from "lucide-react";

import type { Recording } from "@/server/recordings";
import { fmtBytes, fmtClock, fmtElapsed } from "@/lib/apt";
import { cn } from "@/lib/utils";

export interface RecordingsPanelProps {
  recordings: Recording[];
  selectedId: string | null;
  /** Opening past passes is blocked while a recording is running, so
   * browsing history cannot clobber a live decode. */
  openDisabled: boolean;
  onOpen: (recording: Recording) => void;
  onDelete: (id: string) => void;
}

export function RecordingsPanel({
  recordings,
  selectedId,
  openDisabled,
  onOpen,
  onDelete,
}: RecordingsPanelProps) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const totalBytes = recordings.reduce((sum, r) => sum + r.bytes, 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-xs tracking-wide text-muted-foreground uppercase">Recordings</span>
        <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground tabular-nums">
          <HardDrive className="size-3" />
          {fmtBytes(totalBytes)}
        </span>
      </div>

      {recordings.length === 0
        ? <p className="text-xs text-muted-foreground">No recordings yet.</p>
        : (
          <ul className="-mr-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1">
            {recordings.map((r) => {
              const confirming = confirmingId === r.id;
              const canOpen = r.complete && !openDisabled;
              return (
                <li
                  key={r.id}
                  className={cn(
                    "group rounded-md border px-2 py-1.5 transition-colors",
                    selectedId === r.id
                      ? "border-signal/40 bg-signal/10"
                      : "border-transparent hover:border-border hover:bg-card",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => canOpen && onOpen(r)}
                      disabled={!canOpen}
                      title={r.complete
                        ? openDisabled ? "Stop the current pass to open this" : "Open this pass"
                        : "No image — this run was aborted before decoding"}
                      className={cn(
                        "flex min-w-0 flex-1 flex-col items-start text-left",
                        !canOpen && "cursor-not-allowed",
                        !r.complete && "opacity-50",
                      )}
                    >
                      <span className="flex w-full items-center gap-1.5 text-xs font-medium">
                        {!r.complete && <ImageOff className="size-3 shrink-0" />}
                        <span className="truncate">{r.satellite}</span>
                        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                          {fmtElapsed(r.durationSecs)}
                        </span>
                      </span>
                      <span className="flex w-full items-baseline gap-2 font-mono text-[10px] text-muted-foreground tabular-nums">
                        <span className="truncate">{fmtClock(r.startedAt)}</span>
                        <span className="ml-auto shrink-0">{fmtBytes(r.bytes)}</span>
                      </span>
                    </button>

                    {confirming
                      ? (
                        <span className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              onDelete(r.id);
                              setConfirmingId(null);
                            }}
                            className="rounded bg-destructive px-1.5 py-0.5 text-[10px] font-medium text-white"
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmingId(null)}
                            className="rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                          >
                            Cancel
                          </button>
                        </span>
                      )
                      : (
                        <button
                          type="button"
                          onClick={() => setConfirmingId(r.id)}
                          title={`Delete this recording (${fmtBytes(r.bytes)})`}
                          aria-label={`Delete recording from ${fmtClock(r.startedAt)}`}
                          className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/recordings-panel.tsx
git commit -m "feat: add recordings panel with inline delete confirmation

Lists past passes with duration, size, and total disk usage in the header
so accumulated storage is visible rather than discovered later. Aborted
runs list dimmed and unopenable but stay deletable, since those are the
ones holding raw audio and nothing else."
```

---

### Task 10: Image stage

**Files:**
- Create: `src/components/image-stage.tsx`

**Interfaces:**
- Consumes: `CHANNEL_FRACTIONS`, `ChannelMode` from `@/lib/apt` (Task 1); the image route from Task 5
- Produces:
  - `type StageSource = { kind: "live" } | { kind: "recording"; id: string; images: string[] }`
  - `ImageStage` with props `{ source, canvasRef, wrapRef, lines, recording, error, onDismissError }`

  Task 11 renders it and owns the refs.

**Zoom modes: two, not three.** The spec listed `Fit width` / `Whole` / `1:1`. `Whole` is dropped here. It is the only mode that needs the container's *height*, which would force a `ResizeObserver` into the component, and it earns nothing: a short pass already fits entirely in `Fit width`, and a full 15-minute pass at 2080×1800 shrinks to an unreadable smear when contained. `Fit width` and `1:1` are both computable exactly from the media's natural width alone.

**How cropping works.** A channel crop is a viewport `div` with `overflow: hidden` that is narrower than the media inside it, with the media pushed left by a negative margin. Both dimensions derive from `naturalWidth` — known up front for the live canvas (`APT_LINE_WIDTH`), read from the `load` event for an image:

| | viewport width | media width | media `margin-left` |
|---|---|---|---|
| Fit width | `100%` | `${100 / crop.width}%` | `-${(crop.start / crop.width) * 100}%` |
| 1:1 | `${naturalWidth * crop.width}px` | `${naturalWidth}px` | `-${naturalWidth * crop.start}px` |

Percentages in the `Fit width` row resolve against the viewport width, which is what makes the media scale to fill the container while the crop still lands in the right place.

- [ ] **Step 1: Create the image stage**

Create `src/components/image-stage.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";

import { APT_LINE_WIDTH, CHANNEL_FRACTIONS, type ChannelMode } from "@/lib/apt";
import { cn } from "@/lib/utils";

export type StageSource =
  | { kind: "live" }
  | { kind: "recording"; id: string; images: string[] };

type ZoomMode = "fit-width" | "actual";

const ZOOMS: { id: ZoomMode; label: string }[] = [
  { id: "fit-width", label: "Fit width" },
  { id: "actual", label: "1:1" },
];

const CHANNELS: { id: ChannelMode; label: string }[] = [
  { id: "both", label: "A+B" },
  { id: "a", label: "A" },
  { id: "b", label: "B" },
];

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
          className={cn(
            "rounded border px-2 py-0.5 text-[11px] transition-colors",
            value === o.id
              ? "border-signal/40 bg-signal/15 text-signal"
              : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export interface ImageStageProps {
  source: StageSource;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  lines: number;
  recording: boolean;
  error: string | null;
  onDismissError: () => void;
}

export function ImageStage({
  source,
  canvasRef,
  wrapRef,
  lines,
  recording,
  error,
  onDismissError,
}: ImageStageProps) {
  const [zoom, setZoom] = useState<ZoomMode>("fit-width");
  const [channel, setChannel] = useState<ChannelMode>("both");
  // Known up front for the canvas; read from the load event for an image.
  const [naturalWidth, setNaturalWidth] = useState(APT_LINE_WIDTH);

  const live = source.kind === "live";

  // For a finished pass, prefer satdump's dedicated per-channel PNGs —
  // they are the calibrated 909 px video regions with sync, space, and
  // telemetry already stripped. Fall back to cropping raw_sync when a
  // channel file is missing.
  const channelFile = channel === "a" ? "APT-A" : channel === "b" ? "APT-B" : null;
  const useServerChannel = !live && channelFile !== null && source.images.includes(channelFile);
  const imageSrc = live
    ? null
    : `/api/recordings/${source.id}/${useServerChannel ? channelFile : "raw_sync"}`;

  // Crop only when the source is a full-width composite.
  const crop = live || !useServerChannel ? CHANNEL_FRACTIONS[channel] : CHANNEL_FRACTIONS.both;

  // Reset the view whenever the stage switches to a different source.
  const sourceKey = live ? "live" : source.id;
  useEffect(() => {
    setZoom("fit-width");
    setChannel("both");
    setNaturalWidth(APT_LINE_WIDTH);
  }, [sourceKey]);

  async function save() {
    const name = live ? "apt-live.png" : `${source.id}-${useServerChannel ? channelFile : "raw_sync"}.png`;
    let href: string;
    let revoke = false;

    if (live) {
      const canvas = canvasRef.current;
      if (!canvas || canvas.height === 0) return;
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
      if (!blob) return;
      href = URL.createObjectURL(blob);
      revoke = true;
    } else {
      href = imageSrc!;
    }

    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    a.click();
    if (revoke) URL.revokeObjectURL(href);
  }

  const fit = zoom === "fit-width";
  // See the table in this task's header: the viewport clips, the media
  // overflows it, and the negative margin selects which channel shows.
  const viewportStyle: React.CSSProperties = {
    overflow: "hidden",
    width: fit ? "100%" : `${naturalWidth * crop.width}px`,
  };
  const mediaStyle: React.CSSProperties = {
    imageRendering: "pixelated",
    display: "block",
    width: fit ? `${100 / crop.width}%` : `${naturalWidth}px`,
    maxWidth: "none",
    marginLeft: fit
      ? `-${(crop.start / crop.width) * 100}%`
      : `-${naturalWidth * crop.start}px`,
  };

  const empty = live && lines === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive"
        >
          <span className="flex-1">{error}</span>
          <button type="button" onClick={onDismissError} aria-label="Dismiss error">
            <X className="size-4" />
          </button>
        </div>
      )}

      <div ref={wrapRef} className="relative flex min-h-0 flex-1 justify-center overflow-auto p-4">
        {/* The canvas stays mounted whenever the source is live, even with
            nothing decoded yet — the route captures its 2D context on
            mount, and an unmounted canvas would silently drop the first
            lines of a pass. The empty state overlays it instead of
            replacing it. */}
        <div className="self-start bg-black" style={viewportStyle}>
          {live
            ? <canvas ref={canvasRef} aria-label="Live APT decode" style={mediaStyle} />
            : (
              <img
                src={imageSrc!}
                alt="Decoded APT image"
                style={mediaStyle}
                onLoad={(e) => setNaturalWidth(e.currentTarget.naturalWidth)}
              />
            )}
        </div>

        {empty && (
          <p className="pointer-events-none absolute top-24 left-1/2 max-w-[420px] -translate-x-1/2 text-center text-sm text-muted-foreground">
            {recording
              ? "Waiting for the first decoded lines — the image builds top-to-bottom in real time."
              : "No image yet. Start a recording when the satellite is above the horizon."}
          </p>
        )}
      </div>

      <div className="flex items-center gap-4 border-t border-border px-4 py-2">
        <SegmentedControl options={ZOOMS} value={zoom} onChange={setZoom} label="Zoom" />
        <SegmentedControl options={CHANNELS} value={channel} onChange={setChannel} label="Channel" />
        <button
          type="button"
          onClick={save}
          disabled={empty}
          className="ml-auto flex items-center gap-1.5 rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Download className="size-3.5" />
          Save
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/image-stage.tsx
git commit -m "feat: add image stage with zoom and channel modes

Adds fit-width and 1:1 zoom and an A/B channel toggle. A finished pass
uses satdump's dedicated APT-A/APT-B PNGs where they exist and falls back
to a proportional crop of raw_sync otherwise, which is also what the live
canvas uses."
```

---

### Task 11: Assemble the rail-and-stage layout

**Files:**
- Create: `src/components/status-header.tsx`
- Rewrite: `src/routes/index.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1, 4, 6, 7, 8, 9, 10
- Produces: the finished app

- [ ] **Step 1: Create the status header**

Create `src/components/status-header.tsx`:

```tsx
import type { RecorderPhase } from "@/hooks/use-recorder-events";
import { fmtElapsed } from "@/lib/apt";
import { cn } from "@/lib/utils";

const PHASE_LABEL: Record<RecorderPhase, string> = {
  idle: "IDLE",
  recording: "RECORDING",
  decoding: "DECODING",
  stopped: "STOPPED",
};

export interface StatusHeaderProps {
  phase: RecorderPhase;
  satellite: string;
  freq: string;
  elapsed: number;
}

export function StatusHeader({ phase, satellite, freq, elapsed }: StatusHeaderProps) {
  return (
    <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
      <span className="text-sm font-medium">{satellite}</span>
      <span className="font-mono text-xs text-muted-foreground tabular-nums">{freq}</span>

      <div className="ml-auto flex items-center gap-3">
        {phase === "recording" && (
          <span className="size-2 animate-pulse rounded-full bg-destructive" aria-hidden />
        )}
        <span
          className={cn(
            "rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-wider",
            phase === "recording" && "border-destructive/40 bg-destructive/15 text-destructive",
            phase === "decoding" && "border-signal/40 bg-signal/15 text-signal",
            (phase === "idle" || phase === "stopped") && "border-border text-muted-foreground",
          )}
        >
          {PHASE_LABEL[phase]}
        </span>
        {(phase === "recording" || phase === "decoding") && (
          <span className="font-mono text-sm font-medium tabular-nums">{fmtElapsed(elapsed)}</span>
        )}
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Rewrite the route**

Replace the entire contents of `src/routes/index.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Satellite } from "lucide-react";

import {
  deleteRecordingFn,
  listRecordingsFn,
  startRecordingFn,
  stopRecordingFn,
} from "../server/functions";
import type { Recording } from "@/server/recordings";
import { CapturePanel, SATS } from "@/components/capture-panel";
import { ImageStage, type StageSource } from "@/components/image-stage";
import { RecordingsPanel } from "@/components/recordings-panel";
import { SignalPanel } from "@/components/signal-panel";
import { StatusHeader } from "@/components/status-header";
import { type LinePayload, useRecorderEvents } from "@/hooks/use-recorder-events";
import { APT_LINE_WIDTH } from "@/lib/apt";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const Route = createFileRoute("/")({
  component: App,
});

function App() {
  const [sat, setSat] = useState("15");
  const [gain, setGain] = useState("45");
  const [device, setDevice] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [source, setSource] = useState<StageSource>({ kind: "live" });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  const ensureHeight = useCallback((h: number) => {
    const cv = canvasRef.current;
    const ctx = ctxRef.current;
    if (!cv || !ctx || cv.height >= h) return;
    const prev = cv.height > 0 ? ctx.getImageData(0, 0, cv.width, cv.height) : null;
    cv.height = h + 240;
    if (prev) ctx.putImageData(prev, 0, 0);
  }, []);

  const drawRows = useCallback((p: LinePayload) => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const gray = b64ToBytes(p.pixels_b64);
    ensureHeight(p.start_line + p.count);

    const img = ctx.createImageData(p.width, p.count);
    for (let i = 0; i < p.width * p.count; i++) {
      const g = gray[i];
      img.data[i * 4] = g;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = g;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, p.start_line);

    // Follow the newest lines only when already at the bottom, so
    // scrolling up to inspect earlier lines is not undone twice a second.
    const wrap = wrapRef.current;
    if (wrap) {
      const atBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;
      if (atBottom) wrap.scrollTop = wrap.scrollHeight;
    }
  }, [ensureHeight]);

  const { state, reset, setPhase } = useRecorderEvents(drawRows);
  const recording = state.phase === "recording";

  const refreshRecordings = useCallback(async () => {
    try {
      setRecordings(await listRecordingsFn());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    cv.width = APT_LINE_WIDTH;
    cv.height = 0;
    ctxRef.current = cv.getContext("2d");
  }, []);

  useEffect(() => {
    void refreshRecordings();
  }, [refreshRecordings]);

  // A pass finished decoding: pick up its files and show them. If satdump
  // produced nothing the stage stays live, showing the lines this run did
  // decode — they are the only result it produced.
  useEffect(() => {
    if (!state.finishedId) return;
    void (async () => {
      try {
        const fresh = await listRecordingsFn();
        setRecordings(fresh);
        const match = fresh.find((r) => r.id === state.finishedId);
        if (match?.complete) setSource({ kind: "recording", id: match.id, images: match.images });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [state.finishedId]);

  function resetCanvas() {
    const cv = canvasRef.current;
    const ctx = ctxRef.current;
    if (!cv || !ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    cv.height = 0;
  }

  async function start() {
    setError(null);
    resetCanvas();
    reset();
    setSource({ kind: "live" });
    try {
      await startRecordingFn({ data: { sat, gain, device: Number(device) } });
      setPhase("recording");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  }

  async function stop() {
    try {
      await stopRecordingFn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("stopped");
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteRecordingFn({ data: { id } });
      if (source.kind === "recording" && source.id === id) setSource({ kind: "live" });
      await refreshRecordings();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const current = SATS.find((s) => s.id === sat) ?? SATS[0];

  return (
    <main className="grid h-screen grid-cols-[17rem_1fr] overflow-hidden">
      <aside className="flex min-h-0 flex-col gap-5 overflow-y-auto border-r border-border bg-sidebar p-4">
        <div className="flex items-center gap-2">
          <Satellite className="size-4 text-signal" />
          <h1 className="font-mono text-sm tracking-[0.2em] uppercase">satelita</h1>
        </div>

        <CapturePanel
          sat={sat}
          onSatChange={setSat}
          gain={gain}
          onGainChange={setGain}
          device={device}
          onDeviceChange={setDevice}
          recording={recording}
          onStart={start}
          onStop={stop}
        />

        <SignalPanel
          level={state.level}
          sync={state.sync}
          lines={state.lines}
          recording={recording}
        />

        <RecordingsPanel
          recordings={recordings}
          selectedId={source.kind === "recording" ? source.id : null}
          openDisabled={recording}
          onOpen={(r) => setSource({ kind: "recording", id: r.id, images: r.images })}
          onDelete={handleDelete}
        />
      </aside>

      <section className="flex min-h-0 flex-col">
        <StatusHeader
          phase={state.phase}
          satellite={current.label}
          freq={current.freq}
          elapsed={state.elapsed}
        />

        <ImageStage
          source={source}
          canvasRef={canvasRef}
          wrapRef={wrapRef}
          lines={state.lines}
          recording={recording}
          error={error}
          onDismissError={() => setError(null)}
        />

        <div
          className="truncate border-t border-border px-4 py-1.5 font-mono text-[11px] text-muted-foreground"
          title={state.message}
        >
          {state.message}
        </div>
      </section>
    </main>
  );
}
```

- [ ] **Step 3: Typecheck and run all tests**

Run: `npm run build`
Expected: succeeds with no TypeScript errors.

Run: `deno task test`
Expected: PASS — all decoder, recorder, events, recordings, and apt tests.

**Verification target — read before Step 4. `npm run dev` CANNOT verify this task.**

`vite dev` runs under Node, which has no `Deno` global at all. Every `Deno.*` call made at request time from a route or server function throws `ReferenceError: Deno is not defined`, which `recordings.ts`'s `catch` blocks swallow into an empty list or a 404. Under `npm run dev` the recordings panel will therefore appear empty and every image will 404 — not a bug in your code, just the wrong runtime. This matches the README, which already documents `npm run dev` as UI-only and `deno task preview` as the way to exercise Deno-backed behaviour.

Verify against the production build running under real Deno. This was confirmed working before this task was dispatched:

```bash
npm run build && PORT=3111 deno run --allow-env --allow-read --allow-write --allow-net --allow-run=rtl_fm,sox,satdump .output/server/index.mjs
```

Run that in the background, then open it with `preview_start` using `{url: "http://localhost:3111"}` — **not** `{name: "dev"}`. All the browser tools (`read_page`, `computer`, `javascript_tool`, `read_network_requests`, `read_console_messages`) work against that tab normally.

There is no hot reload on this path. After changing any source file, rebuild and restart the server before re-checking. Because of that, get the code compiling and the tests passing first, and treat the browser pass as a single verification sweep rather than an edit loop.

`preview_logs` will not carry the Deno server's output on this path (the server is started by you, not by `preview_start`), so redirect its stdout/stderr to a file and read that when you need server-side errors.

- [ ] **Step 4: Verify the layout renders**

Start the built server under Deno as described above, open it with `preview_start` `{url: "http://localhost:3111"}`, then `read_page`.

Expected to see, in order: the `satelita` heading; a `Satellite` combobox; a gain slider and its numeric textbox; an `AGC` toggle; a `Device` textbox; a `Record` button; `Level`, `Sync lock`, and `Lines` labels; a `Recordings` heading with a total size readout; 9 recording rows; the `IDLE` status chip; zoom and channel segmented controls; a `Save` button; and the status line.

Then check the console:

`read_console_messages` with `{onlyErrors: true}`
Expected: no errors. Note that the `useContext` SSR warning documented in the README is a **dev-mode-only** artifact and does not occur in the production build you are testing against — so on this path there is no known-noise exemption. Any error you see here is real; investigate it.

- [ ] **Step 5: Verify opening a past recording**

Click the first complete recording row (`computer` with its `ref`), then `read_page`.

Expected: an `img` with alt `Decoded APT image` replaces the empty-state text, and the row is highlighted.

Confirm the correct image is being served:

`read_network_requests` with `{urlPattern: "/api/recordings/"}`
Expected: a `200` for `/api/recordings/<id>/raw_sync`.

Click the `A` channel button, then re-check network requests.
Expected: a `200` for `/api/recordings/<id>/APT-A`.

Click `1:1`, then verify via `javascript_tool`:

```js
const i = document.querySelector('img[alt="Decoded APT image"]');
JSON.stringify({ natural: [i.naturalWidth, i.naturalHeight], rendered: [i.clientWidth, i.clientHeight] })
```

Expected: for `APT-A` at 1:1, `natural` is `[909, 220]` and `rendered` width equals 909.

- [ ] **Step 6: Verify the page never scrolls horizontally**

`javascript_tool`:

```js
JSON.stringify({ bodyScroll: document.body.scrollWidth, clientWidth: document.documentElement.clientWidth })
```

Expected: `bodyScroll` ≤ `clientWidth`. Wide content must scroll inside the stage's own container, never the page. If it does not hold, fix the stage's overflow containment before continuing.

- [ ] **Step 7: Verify deletion against a throwaway recording**

Do **not** delete one of the user's 9 real recordings. Create a disposable one first:

```bash
mkdir -p ~/.local/share/com.magmast.satelita/recordings/noaa18-1000000000/decode
head -c 120000 /dev/zero > ~/.local/share/com.magmast.satelita/recordings/noaa18-1000000000/signal.raw
```

Reload the page. Expected: a `NOAA-18` row appears, dimmed and unopenable (empty `decode/`), showing a duration of `0:01`.

Hover its row, click the trash icon, confirm the inline `Delete` button appears, click it. Expected: the row disappears and the total-size readout drops.

Confirm on disk:

```bash
ls ~/.local/share/com.magmast.satelita/recordings/ | grep noaa18-1000000000 || echo "deleted"
```

Expected: `deleted`, and the other 9 recordings still present:

```bash
ls ~/.local/share/com.magmast.satelita/recordings/ | wc -l
```

Expected: `9`

- [ ] **Step 8: Verify the error path**

Trigger a real failure by requesting a device that does not exist. Set the Device field to `99` and click Record.

Expected: the red error banner appears in the stage header with the `rtl_fm` failure message, the status chip returns to `IDLE`, and clicking the dismiss `X` removes the banner without shifting the image.

- [ ] **Step 9: Screenshot the result**

`computer` with `{action: "screenshot"}` — capture the finished layout for the user. If the Browser pane is not displayed, say so rather than claiming a visual check that did not happen.

- [ ] **Step 10: Commit**

```bash
git add src/components/status-header.tsx src/routes/index.tsx
git commit -m "feat: assemble the rail-and-stage layout

Replaces the 244-line monolithic route with composition over the new hook
and components. Long status text moves out of the Badge it overflowed
into a truncating status line, errors render as a dismissible banner
instead of an Alert that shoved the image down, and the canvas follows new
lines only when already scrolled to the bottom."
```

- [ ] **Step 11: Update the README**

The README documents the app's requirements and known issues but says nothing about what the UI does. Add a short `## Using the app` section after the `## Requirements` section:

```markdown
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
```

- [ ] **Step 12: Commit the README**

```bash
git add README.md
git commit -m "docs: document the redesigned UI"
```

---

## Verification limits

`rtl_fm`, `sox`, and `satdump` are installed on this machine, and 9 real
recordings totalling 291 MB are on disk — so the recordings list, image
route, channel toggle, zoom, deletion, and error paths are all verifiable
against real data.

**Not verifiable here:** the live signal meters and live decode against a
real transmission. Task 2 exercises the sync metric with a synthetic APT
signal and Task 3 unit-tests the level helper, but whether an RTL-SDR
dongle is attached is unknown and a satellite pass cannot be produced on
demand. Real-world `Level` and `Sync lock` behaviour during an actual pass
needs confirmation by the user on the air.
