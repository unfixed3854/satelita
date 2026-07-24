# Tauri to TanStack Start (deno desktop) Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Tauri/Rust desktop shell of `satelita` (a live NOAA APT satellite-image decoder) with a TanStack Start (React + Vite + Nitro) app running entirely on Deno, packaged as a native app via `deno desktop`.

**Architecture:** UI stays React, now served by TanStack Start. `startRecording`/`stopRecording` become TanStack Start server functions that spawn `rtl_fm`/`sox`/`satdump` via `Deno.Command` (replacing Rust's `std::process::Command`). The real-time line-by-line image stream, previously pushed via Tauri's `emit`/`listen`, is now pushed over Server-Sent Events from a TanStack Start server route. The APT DSP decoder (`apt.rs`) is ported 1:1 to TypeScript.

**Tech Stack:** Deno 2.9+ (`deno desktop`), TanStack Start (`@tanstack/react-start`, `@tanstack/react-router`), Vite 8, React 19, `@std/assert` + `@std/encoding` (Deno std), `deno test` as the test runner.

## Global Constraints

- `rtl_fm`, `sox`, and `satdump` remain required system binaries on `PATH` — this migration does not change or wrap that dependency.
- App identifier stays `com.magmast.satelita` (carried over from `src-tauri/tauri.conf.json`).
- Event payload shapes are unchanged: `LinePayload { start_line, width, count, pixels_b64 }`, `StatusPayload { state, message, elapsed_secs }`, `FinalPayload { data_url }`.
- `CAPTURE_RATE = 60_000` (rtl_fm FM-demod output rate) and `APT_LINE_WIDTH = 2080` are carried over unchanged from `recorder.rs`/`apt.rs`.
- The ported DSP decoder must reproduce the original Rust decoder's behavior: the ported synthetic-signal test must show a Pearson correlation > 0.85 between a decoded line and its best-matching source line (same threshold as the original `#[test] reconstructs_synthetic_apt`).
- No UI/UX redesign — this is a framework/runtime migration only.
- No new automated integration tests against real `rtl_fm`/`sox`/`satdump`/SDR hardware — matches the original project's testing scope (only `apt.rs` had automated tests).

---

## File Structure

```
deno.json                          # Deno tasks, permissions-bearing task commands, `desktop` packaging config
package.json                       # npm deps for the TanStack Start / Vite toolchain
vite.config.ts                     # tanstackStart + viteReact + nitro plugins
tsconfig.json                      # single tsconfig (no more tsconfig.node.json)
icons/                             # moved from src-tauri/icons/
public/
  vite.svg                         # kept (favicon)
src/
  router.tsx                       # createRouter()
  app.css                          # moved from src/App.css
  routes/
    __root.tsx                     # HTML shell
    index.tsx                      # main UI (ported from src/App.tsx)
    api/
      recorder-events.ts           # SSE server route: GET /api/recorder-events
  server/
    apt-decoder.ts                 # ported from src-tauri/src/apt.rs
    apt-decoder.test.ts            # ported from apt.rs's #[test] reconstructs_synthetic_apt
    events.ts                      # in-memory SSE pub/sub
    events.test.ts
    paths.ts                       # per-OS app-data-dir resolution (replaces Tauri's app.path().app_data_dir())
    recorder.ts                    # ported from src-tauri/src/recorder.rs
    recorder.test.ts               # pure-function tests only (freqForSat, bytesToSamples)
    functions.ts                   # createServerFn wrappers: startRecordingFn, stopRecordingFn

Removed: src-tauri/ (entire directory), index.html, src/main.tsx, src/App.tsx,
src/App.css, src/vite-env.d.ts, tsconfig.node.json, public/tauri.svg,
src/assets/, @tauri-apps/* npm deps.
```

---

### Task 1: Remove Tauri, scaffold TanStack Start on Deno

**Files:**
- Delete: `src-tauri/` (entire directory, after copying `src-tauri/icons/` to `icons/`)
- Delete: `index.html`, `src/main.tsx`, `src/App.tsx`, `src/vite-env.d.ts`, `tsconfig.node.json`, `public/tauri.svg`, `src/assets/react.svg`
- Modify: `package.json`, `vite.config.ts`, `tsconfig.json`, `.gitignore`
- Create: `deno.json`, `src/router.tsx`, `src/routes/__root.tsx`, `src/routes/index.tsx` (placeholder), `icons/` (copied)
- Rename: `src/App.css` → `src/app.css`

**Interfaces:**
- Produces: a booting TanStack Start dev server serving a placeholder `/` route. Later tasks replace `src/routes/index.tsx`'s contents.

- [ ] **Step 1: Copy the Tauri icons out before deleting `src-tauri/`**

```bash
mkdir -p icons
cp src-tauri/icons/32x32.png src-tauri/icons/128x128.png src-tauri/icons/128x128@2x.png src-tauri/icons/icon.icns src-tauri/icons/icon.ico src-tauri/icons/icon.png icons/
```

- [ ] **Step 2: Remove the Tauri toolchain and the old Vite/React-only scaffold**

```bash
git rm -r src-tauri
git rm index.html src/main.tsx src/App.tsx src/vite-env.d.ts tsconfig.node.json public/tauri.svg
git rm -r src/assets
git mv src/App.css src/app.css
```

- [ ] **Step 3: Replace `package.json`**

```json
{
  "name": "satelita",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "sideEffects": false,
  "scripts": {
    "dev": "vite dev",
    "build": "vite build && tsc --noEmit"
  },
  "dependencies": {
    "@tanstack/react-router": "^1.170.18",
    "@tanstack/react-start": "^1.168.32",
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.5.4",
    "@types/react": "^19.1.8",
    "@types/react-dom": "^19.1.6",
    "@vitejs/plugin-react": "^6.0.1",
    "nitro": "^3.0.260311-beta",
    "typescript": "~5.8.3",
    "vite": "^8.0.14"
  }
}
```

- [ ] **Step 4: Replace `vite.config.ts`**

```ts
import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";

export default defineConfig({
  server: {
    port: 1420,
  },
  plugins: [tanstackStart({ srcDirectory: "src" }), viteReact(), nitro()],
});
```

- [ ] **Step 5: Replace `tsconfig.json`**

```json
{
  "include": ["**/*.ts", "**/*.tsx", "**/*.d.ts"],
  "compilerOptions": {
    "strict": true,
    "esModuleInterop": true,
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["DOM", "DOM.Iterable", "ES2024"],
    "isolatedModules": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "target": "ES2024",
    "allowJs": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true
  }
}
```

- [ ] **Step 6: Create `deno.json`**

```json
{
  "imports": {
    "@std/assert": "jsr:@std/assert@^1",
    "@std/encoding": "jsr:@std/encoding@^1"
  },
  "tasks": {
    "dev": "deno desktop --hmr --allow-env --allow-read --allow-write --allow-net --allow-run=rtl_fm,sox,satdump .",
    "build": "npm run build && deno desktop --allow-env --allow-read --allow-write --allow-net --allow-run=rtl_fm,sox,satdump .",
    "test": "deno test --allow-env --allow-read --allow-write src/server/"
  },
  "desktop": {
    "app": {
      "name": "satelita",
      "identifier": "com.magmast.satelita",
      "icons": {
        "macos": "./icons/icon.icns",
        "windows": "./icons/icon.ico",
        "linux": "./icons/icon.png"
      }
    },
    "output": {
      "macos": "./dist/satelita.app",
      "windows": "./dist/satelita",
      "linux": "./dist/satelita"
    }
  }
}
```

> Note for the implementer: `deno desktop`'s exact flags shipped only weeks before this plan was written and documentation coverage is incomplete. Before relying on the `dev`/`build` tasks above, run `deno desktop --help` and adjust flag names if they've changed.

- [ ] **Step 7: Create `src/router.tsx`**

```tsx
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({ routeTree });
}
```

- [ ] **Step 8: Create `src/routes/__root.tsx`**

```tsx
/// <reference types="vite/client" />
import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "../app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "satelita" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/vite.svg" },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
```

- [ ] **Step 9: Create a placeholder `src/routes/index.tsx`** (Task 6 replaces this with the full ported UI)

```tsx
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: () => <main>satelita — coming online</main>,
});
```

- [ ] **Step 10: Update `.gitignore`** — add these lines:

```
.output
src/routeTree.gen.ts
dist
```

(`dist` may already be present from the old Vite template — don't duplicate it if so.)

- [ ] **Step 11: Install dependencies and verify the dev server boots**

```bash
npm install
npm run dev &
sleep 3
curl -s http://localhost:1420/ | grep -o "satelita — coming online"
kill %1
```

Expected: the `curl` output prints `satelita — coming online`, confirming the TanStack Start route tree, root shell, and placeholder route all wired up correctly. (This checks the underlying Vite/Nitro server directly — it doesn't require the `deno` CLI or a GUI. Verifying `deno task dev` opens a native window is a manual step; see Task 7.)

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "chore: scaffold TanStack Start on Deno, remove Tauri toolchain"
```

---

### Task 2: Port the APT DSP decoder

**Files:**
- Create: `src/server/apt-decoder.ts`
- Create: `src/server/apt-decoder.test.ts`

**Interfaces:**
- Produces: `export class AptDecoder { constructor(sampleRate: number); linesOut: number; process(samples: Float32Array): Uint8Array[] }`, `export const APT_LINE_WIDTH = 2080`. Task 4's `recorder.ts` consumes both.

- [ ] **Step 1: Write the failing test** — port of `apt.rs`'s `reconstructs_synthetic_apt`

Create `src/server/apt-decoder.test.ts`:

```ts
import { assert } from "@std/assert";
import { AptDecoder, APT_LINE_WIDTH } from "./apt-decoder.ts";

const PIXELS_PER_SEC = 4160;
const SUBCARRIER_HZ = 2400;

function testImage(width: number, height: number): Uint8Array[] {
  const img: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(width);
    for (let x = 0; x < width; x++) {
      let v: number;
      if (x < 28) {
        v = Math.floor(x / 2) % 2 === 0 ? 255 : 0; // sync A
      } else if (x < 60) {
        v = 0; // space
      } else {
        const bars = Math.floor(x / 64) % 2 === 0 ? 200 : 60;
        const block = x > 900 && x < 1200 && y > 8 && y < 24 ? 255 : bars;
        const grad = Math.floor((y * 255) / height);
        v = Math.min(255, Math.max(0, Math.trunc((block + grad) / 2)));
      }
      row[x] = v;
    }
    img.push(row);
  }
  return img;
}

function synthAudio(img: Uint8Array[], width: number, fs: number): Float32Array {
  const spp = fs / PIXELS_PER_SEC;
  const totalPixels = width * img.length;
  const totalSamples = Math.floor(totalPixels * spp);
  const audio = new Float32Array(totalSamples);
  for (let n = 0; n < totalSamples; n++) {
    const pixelIdx = Math.floor(n / spp);
    const px = pixelIdx % width;
    const py = Math.min(Math.floor(pixelIdx / width), img.length - 1);
    const v = img[py][px] / 255;
    const amp = 0.1 + 0.9 * v;
    const carrier = Math.sin((2 * Math.PI * SUBCARRIER_HZ * n) / fs);
    audio[n] = amp * carrier;
  }
  return audio;
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return num / Math.max(Math.sqrt(da) * Math.sqrt(db), 1e-9);
}

Deno.test("reconstructs synthetic APT image", () => {
  const fs = 60_000;
  const width = APT_LINE_WIDTH;
  const height = 40;
  const img = testImage(width, height);
  const audio = synthAudio(img, width, fs);

  const dec = new AptDecoder(fs);
  const lines: Uint8Array[] = [];
  const chunkSize = 8192;
  for (let i = 0; i < audio.length; i += chunkSize) {
    const chunk = audio.subarray(i, Math.min(i + chunkSize, audio.length));
    lines.push(...dec.process(chunk));
  }

  assert(lines.length >= height - 3, `expected ~${height} lines, got ${lines.length}`);

  const li = Math.floor(lines.length / 2);
  const decLine = lines[li].slice(100, 2000);
  let best = -1;
  for (let iy = 0; iy < height; iy++) {
    const inLine = img[iy].slice(100, 2000);
    best = Math.max(best, pearson(decLine, inLine));
  }

  console.log(`decoded ${lines.length} lines, best line correlation = ${best.toFixed(3)}`);
  assert(best > 0.85, `decoded image correlation too low: ${best.toFixed(3)}`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
deno test --allow-env src/server/apt-decoder.test.ts
```

Expected: FAIL — `Module not found "./apt-decoder.ts"` (the module doesn't exist yet).

- [ ] **Step 3: Create `src/server/apt-decoder.ts`**

```ts
// Minimal real-time NOAA APT decoder — ported from src-tauri/src/apt.rs
// (removed). Consumes a stream of FM-demodulated audio samples and
// produces 8-bit grayscale image lines, emitting each line as soon as its
// pixels exist (~2 lines/second — the physical APT rate).
//
// Signal path per sample:
//   1. mix the 2400 Hz AM subcarrier down to baseband (complex),
//   2. 2-pole low-pass I/Q to recover the envelope = pixel brightness,
//   3. box-average resample to the 4160 px/s pixel rate,
//   4. adaptive (EMA mean/std) normalization to 0..255,
//   5. sync-align pixels into 2080-wide lines via sync-A correlation.

export const APT_LINE_WIDTH = 2080;
const PIXELS_PER_SEC = 4160;
const SUBCARRIER_HZ = 2400;
const SYNC_SEARCH = 64;
const SYNC_TPL = 28;
const TAU = Math.PI * 2;

export class AptDecoder {
  private phase = 0;
  private readonly phaseInc: number;
  private readonly lpfAlpha: number;
  private i1 = 0;
  private i2 = 0;
  private q1 = 0;
  private q2 = 0;

  private readonly samplesPerPixel: number;
  private pixPhase = 0;
  private pixSum = 0;
  private pixCnt = 0;

  private mean = 0;
  private variance = 0.01;
  private readonly normAlpha = 2e-4;
  private seeded = false;

  private pixbuf: number[] = [];
  linesOut = 0;

  constructor(sampleRate: number) {
    this.phaseInc = (TAU * SUBCARRIER_HZ) / sampleRate;
    this.lpfAlpha = 1 - Math.exp((-2 * Math.PI * SUBCARRIER_HZ) / sampleRate);
    this.samplesPerPixel = sampleRate / PIXELS_PER_SEC;
  }

  /** Feed audio samples (roughly [-1, 1]); returns any completed 8-bit
   * grayscale lines (each APT_LINE_WIDTH bytes). */
  process(samples: Float32Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (const x of samples) {
      // 1. mix 2400 Hz subcarrier to baseband
      const s = Math.sin(this.phase);
      const c = Math.cos(this.phase);
      this.phase += this.phaseInc;
      if (this.phase > TAU) this.phase -= TAU;
      const i = x * c;
      const q = -x * s;

      // 2. 2-pole low-pass on I/Q, then magnitude = envelope
      this.i1 += this.lpfAlpha * (i - this.i1);
      this.i2 += this.lpfAlpha * (this.i1 - this.i2);
      this.q1 += this.lpfAlpha * (q - this.q1);
      this.q2 += this.lpfAlpha * (this.q1 - this.q2);
      const env = Math.sqrt(this.i2 * this.i2 + this.q2 * this.q2);

      // 3. box-average resample to pixel rate
      this.pixSum += env;
      this.pixCnt += 1;
      this.pixPhase += 1;
      if (this.pixPhase >= this.samplesPerPixel) {
        this.pixPhase -= this.samplesPerPixel;
        const pv = this.pixSum / Math.max(this.pixCnt, 1);
        this.pixSum = 0;
        this.pixCnt = 0;
        this.pushPixel(pv, out);
      }
    }
    return out;
  }

  private pushPixel(v: number, out: Uint8Array[]): void {
    // 4. adaptive normalization stats
    if (!this.seeded) {
      this.mean = v;
      this.seeded = true;
    } else {
      const d = v - this.mean;
      this.mean += this.normAlpha * d;
      this.variance += this.normAlpha * (d * d - this.variance);
    }

    this.pixbuf.push(v);

    // 5. emit sync-aligned lines while we have enough pixels buffered
    while (this.pixbuf.length >= APT_LINE_WIDTH + SYNC_SEARCH) {
      const start = this.findLineStart();
      const line = new Uint8Array(APT_LINE_WIDTH);
      for (let k = 0; k < APT_LINE_WIDTH; k++) {
        line[k] = this.toU8(this.pixbuf[start + k]);
      }
      out.push(line);
      this.linesOut++;
      this.pixbuf.splice(0, start + APT_LINE_WIDTH);
    }
  }

  private toU8(v: number): number {
    const std = Math.sqrt(Math.max(this.variance, 1e-9));
    const lo = this.mean - 1.6 * std;
    const hi = this.mean + 1.6 * std;
    const t = ((v - lo) / Math.max(hi - lo, 1e-9)) * 255;
    const clamped = Math.min(255, Math.max(0, t));
    return Math.trunc(clamped);
  }

  /** Search a small window for the sync-A pulse train and return the offset
   * that best aligns the next line. Falls back to offset 0 (fixed stride)
   * when no clear sync is present (e.g. noise). */
  private findLineStart(): number {
    let best = 0;
    let bestScore = -Infinity;
    for (let o = 0; o <= SYNC_SEARCH; o++) {
      let score = 0;
      for (let k = 0; k < SYNC_TPL; k++) {
        // 2 px high, 2 px low, repeating -> +/- template
        const t = Math.floor(k / 2) % 2 === 0 ? 1 : -1;
        score += t * (this.pixbuf[o + k] - this.mean);
      }
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }
    return best;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
deno test --allow-env src/server/apt-decoder.test.ts
```

Expected: PASS, with a logged line like `decoded 40 lines, best line correlation = 0.9xx`.

- [ ] **Step 5: Commit**

```bash
git add src/server/apt-decoder.ts src/server/apt-decoder.test.ts
git commit -m "feat: port APT DSP decoder from Rust to TypeScript"
```

---

### Task 3: SSE broadcast pub/sub

**Files:**
- Create: `src/server/events.ts`
- Create: `src/server/events.test.ts`

**Interfaces:**
- Produces: `export function subscribe(controller: ReadableStreamDefaultController<Uint8Array>): void`, `export function unsubscribe(controller: ReadableStreamDefaultController<Uint8Array>): void`, `export function broadcast(event: string, payload: unknown): void`. Task 4's `recorder.ts` calls `broadcast`; Task 5's SSE route calls `subscribe`/`unsubscribe`.

- [ ] **Step 1: Write the failing test**

Create `src/server/events.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { broadcast, clientCount, subscribe, unsubscribe } from "./events.ts";

function makeStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return { stream, controller };
}

Deno.test("broadcast fans out to every subscribed client", async () => {
  const a = makeStream();
  const b = makeStream();
  subscribe(a.controller);
  subscribe(b.controller);

  broadcast("apt-status", { state: "recording", message: "hi", elapsed_secs: 0 });

  const decoder = new TextDecoder();
  const { value: valueA } = await a.stream.getReader().read();
  const { value: valueB } = await b.stream.getReader().read();

  assertEquals(
    decoder.decode(valueA),
    'event: apt-status\ndata: {"state":"recording","message":"hi","elapsed_secs":0}\n\n',
  );
  assertEquals(decoder.decode(valueB), decoder.decode(valueA));

  unsubscribe(a.controller);
  unsubscribe(b.controller);
});

Deno.test("unsubscribe stops a client from receiving further broadcasts", () => {
  const before = clientCount();
  const a = makeStream();
  subscribe(a.controller);
  assertEquals(clientCount(), before + 1);
  unsubscribe(a.controller);
  assertEquals(clientCount(), before);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
deno test --allow-env src/server/events.test.ts
```

Expected: FAIL — `Module not found "./events.ts"`.

- [ ] **Step 3: Create `src/server/events.ts`**

```ts
// In-memory pub/sub for pushing recorder events to connected SSE clients.
// Mirrors what Tauri's `app.emit()` did for every webview; here there can
// be multiple HTTP clients, so each gets its own SSE stream controller.

type Controller = ReadableStreamDefaultController<Uint8Array>;

const clients = new Set<Controller>();
const encoder = new TextEncoder();

export function subscribe(controller: Controller): void {
  clients.add(controller);
}

export function unsubscribe(controller: Controller): void {
  clients.delete(controller);
}

export function broadcast(event: string, payload: unknown): void {
  const frame = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  for (const controller of clients) {
    try {
      controller.enqueue(frame);
    } catch {
      // Client disconnected without its abort signal firing yet; drop it.
      clients.delete(controller);
    }
  }
}

export function clientCount(): number {
  return clients.size;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
deno test --allow-env src/server/events.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/events.ts src/server/events.test.ts
git commit -m "feat: add in-memory SSE broadcast pub/sub"
```

---

### Task 4: Port the recorder session orchestration

**Files:**
- Create: `src/server/paths.ts`
- Create: `src/server/recorder.ts`
- Create: `src/server/recorder.test.ts`

**Interfaces:**
- Consumes: `AptDecoder`, `APT_LINE_WIDTH` from `./apt-decoder.ts` (Task 2); `broadcast` from `./events.ts` (Task 3).
- Produces: `export function freqForSat(sat: string): string | undefined`, `export function bytesToSamples(buf: Uint8Array, carry: { byte: number | null }): Float32Array`, `export async function startRecording(sat: string, gain: string, device: number): Promise<string>`, `export async function stopRecording(): Promise<string>`, `export function abortActiveSession(): void`. Task 5's `functions.ts` consumes `startRecording`/`stopRecording`.

- [ ] **Step 1: Write the failing test** — pure-function coverage only (no process spawning, matching the original Rust project's lack of coverage for `recorder.rs`'s orchestration)

Create `src/server/recorder.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { bytesToSamples, freqForSat } from "./recorder.ts";

Deno.test("freqForSat maps known satellites", () => {
  assertEquals(freqForSat("15"), "137.620M");
  assertEquals(freqForSat("18"), "137.9125M");
  assertEquals(freqForSat("19"), "137.100M");
  assertEquals(freqForSat("99"), undefined);
});

Deno.test("bytesToSamples decodes little-endian s16 pairs to [-1, 1] floats", () => {
  const carry = { byte: null as number | null };
  // s16 LE: 0x0000 -> 0.0, 0x7FFF -> ~1.0, 0x8000 -> -1.0
  const buf = new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80]);
  const samples = bytesToSamples(buf, carry);
  assertEquals(samples.length, 3);
  assertEquals(samples[0], 0);
  assertEquals(Math.abs(samples[1] - 0x7fff / 32768) < 1e-9, true);
  assertEquals(samples[2], -1);
  assertEquals(carry.byte, null);
});

Deno.test("bytesToSamples carries a trailing odd byte to the next call", () => {
  const carry = { byte: null as number | null };
  const first = bytesToSamples(new Uint8Array([0x00, 0x00, 0x11]), carry);
  assertEquals(first.length, 1);
  assertEquals(carry.byte, 0x11);

  const second = bytesToSamples(new Uint8Array([0x22]), carry);
  assertEquals(second.length, 1);
  assertEquals(carry.byte, null);
  const expected = ((0x22 << 8) | 0x11) / 32768;
  assertEquals(Math.abs(second[0] - expected) < 1e-9, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
deno test --allow-env src/server/recorder.test.ts
```

Expected: FAIL — `Module not found "./recorder.ts"`.

- [ ] **Step 3: Create `src/server/paths.ts`**

```ts
// Per-OS app-data-directory resolution, replacing Tauri's
// `app.path().app_data_dir()`.

const APP_ID = "com.magmast.satelita";

export function appDataDir(): string {
  const os = Deno.build.os;
  if (os === "darwin") {
    return `${Deno.env.get("HOME")}/Library/Application Support/${APP_ID}`;
  }
  if (os === "windows") {
    const appData = Deno.env.get("APPDATA") ?? `${Deno.env.get("USERPROFILE")}\\AppData\\Roaming`;
    return `${appData}\\${APP_ID}`;
  }
  const xdg = Deno.env.get("XDG_DATA_HOME") ?? `${Deno.env.get("HOME")}/.local/share`;
  return `${xdg}/${APP_ID}`;
}

export function recordingsDir(runId: string): string {
  return `${appDataDir()}/recordings/${runId}`;
}
```

- [ ] **Step 4: Create `src/server/recorder.ts`**

```ts
// NOAA APT live recorder — ported from src-tauri/src/recorder.rs (removed).
// `rtl_fm` owns the SDR and streams FM-demodulated audio straight into an
// async reader loop, which (a) appends the raw samples to `signal.raw` for
// the final satdump decode, and (b) feeds them to an incremental
// AptDecoder that emits image lines the moment they are decoded
// (~2 lines/second).
//
// Broadcast events (see events.ts), same shape as the old Tauri events:
//   apt-line   { start_line, width, count, pixels_b64 }
//   apt-final  { data_url }
//   apt-status { state, message, elapsed_secs }

import { encodeBase64 } from "@std/encoding/base64";
import { AptDecoder, APT_LINE_WIDTH } from "./apt-decoder.ts";
import { broadcast } from "./events.ts";
import { recordingsDir } from "./paths.ts";

const CAPTURE_RATE = 60_000; // rtl_fm FM-demod output rate (also the DSP rate)

export function freqForSat(sat: string): string | undefined {
  switch (sat) {
    case "15":
      return "137.620M";
    case "18":
      return "137.9125M";
    case "19":
      return "137.100M";
    default:
      return undefined;
  }
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function emitStatus(state: string, message: string, elapsedSecs: number): void {
  broadcast("apt-status", { state, message, elapsed_secs: elapsedSecs });
}

/** Convert a chunk of little-endian s16 PCM bytes to [-1, 1] float samples,
 * carrying a possible odd trailing byte over to the next call. */
export function bytesToSamples(buf: Uint8Array, carry: { byte: number | null }): Float32Array {
  const samples: number[] = [];
  let idx = 0;
  if (carry.byte !== null && buf.length >= 1) {
    const lo = carry.byte;
    const hi = buf[0];
    const u = (hi << 8) | lo;
    const signed = u >= 0x8000 ? u - 0x10000 : u;
    samples.push(signed / 32768);
    idx = 1;
    carry.byte = null;
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (idx + 1 < buf.length) {
    samples.push(view.getInt16(idx, true) / 32768);
    idx += 2;
  }
  if (idx < buf.length) {
    carry.byte = buf[idx];
  }
  return Float32Array.from(samples);
}

interface Session {
  rtl: Deno.ChildProcess;
  reader: Promise<void>;
  runDir: string;
  sat: string;
  startEpoch: number;
}

let session: Session | null = null;

async function readerLoop(
  stdout: ReadableStream<Uint8Array>,
  rawPath: string,
  startEpoch: number,
): Promise<void> {
  const rawFile = await Deno.open(rawPath, { create: true, write: true, truncate: true });
  const decoder = new AptDecoder(CAPTURE_RATE);
  const carry = { byte: null as number | null };
  let lastStatus = -1;

  const reader = stdout.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      await rawFile.write(value);

      const samples = bytesToSamples(value, carry);
      const startLine = decoder.linesOut;
      const lines = decoder.process(samples);
      if (lines.length > 0) {
        const flat = new Uint8Array(lines.length * APT_LINE_WIDTH);
        lines.forEach((l, i) => flat.set(l, i * APT_LINE_WIDTH));
        broadcast("apt-line", {
          start_line: startLine,
          width: APT_LINE_WIDTH,
          count: lines.length,
          pixels_b64: encodeBase64(flat),
        });
      }

      const elapsed = nowSecs() - startEpoch;
      if (elapsed !== lastStatus) {
        lastStatus = elapsed;
        const msg = decoder.linesOut > 0 ? `Live · ${decoder.linesOut} lines` : "Waiting for signal…";
        emitStatus("recording", msg, elapsed);
      }
    }
  } finally {
    reader.releaseLock();
    rawFile.close();
  }
}

/** Run sox + satdump on the full recording for the polished final image. */
async function finalDecode(runDir: string, sat: string, startEpoch: number): Promise<Uint8Array | null> {
  const raw = `${runDir}/signal.raw`;
  const snap = `${runDir}/snapshot.wav`;
  const decodeDir = `${runDir}/decode`;

  try {
    const stat = await Deno.stat(raw);
    if (stat.size === 0) return null;
  } catch {
    return null;
  }

  const sox = await new Deno.Command("sox", {
    args: ["-t", "raw", "-r", String(CAPTURE_RATE), "-e", "signed", "-b", "16", "-c", "1", raw, snap],
    stderr: "null",
  }).output();
  if (!sox.success) return null;

  await new Deno.Command("satdump", {
    args: [
      "legacy",
      "noaa_apt",
      "audio_wav",
      snap,
      decodeDir,
      "--satellite_number",
      sat,
      "--start_timestamp",
      String(startEpoch),
    ],
    stdout: "null",
    stderr: "null",
  }).output();

  try {
    return await Deno.readFile(`${decodeDir}/raw_sync.png`);
  } catch {
    return null;
  }
}

export async function startRecording(sat: string, gain: string, device: number): Promise<string> {
  if (session !== null) {
    throw new Error("Already recording — stop the current pass first.");
  }

  const freq = freqForSat(sat);
  if (!freq) throw new Error("Unknown satellite (use 15, 18 or 19).");

  const startEpoch = nowSecs();
  const runDir = recordingsDir(`noaa${sat}-${startEpoch}`);
  await Deno.mkdir(`${runDir}/decode`, { recursive: true });

  const rtlArgs = ["-d", String(device), "-f", freq, "-M", "fm", "-s", String(CAPTURE_RATE), "-E", "dc", "-F", "9"];
  if (gain !== "agc" && gain !== "auto") {
    rtlArgs.push("-g", gain);
  }
  rtlArgs.push("-");

  let rtl: Deno.ChildProcess;
  try {
    rtl = new Deno.Command("rtl_fm", { args: rtlArgs, stdout: "piped", stderr: "piped" }).spawn();
  } catch (e) {
    throw new Error(`Failed to start rtl_fm: ${e instanceof Error ? e.message : e}`);
  }

  const rtlLog = await Deno.open(`${runDir}/rtl.log`, { create: true, write: true, truncate: true });
  rtl.stderr.pipeTo(rtlLog.writable).catch(() => {});

  const rawPath = `${runDir}/signal.raw`;
  const reader = readerLoop(rtl.stdout, rawPath, startEpoch);

  session = { rtl, reader, runDir, sat, startEpoch };

  emitStatus("recording", `Recording NOAA-${sat} on ${freq}`, 0);
  return `Recording NOAA-${sat} (${freq})`;
}

export async function stopRecording(): Promise<string> {
  if (session === null) {
    throw new Error("Not recording.");
  }
  const current = session;
  session = null;

  try {
    current.rtl.kill("SIGTERM");
  } catch {
    // already exited
  }
  await current.rtl.status;
  await current.reader;

  const elapsed = nowSecs() - current.startEpoch;
  emitStatus("stopped", "Running final decode…", elapsed);

  (async () => {
    const png = await finalDecode(current.runDir, current.sat, current.startEpoch);
    if (png) {
      broadcast("apt-final", { data_url: `data:image/png;base64,${encodeBase64(png)}` });
    }
    emitStatus("stopped", `Stopped. Files in ${current.runDir}`, elapsed);
  })();

  return current.runDir;
}

/** Kill any active session's SDR process (used on process exit). */
export function abortActiveSession(): void {
  if (session !== null) {
    try {
      session.rtl.kill("SIGTERM");
    } catch {
      // already exited
    }
    session = null;
  }
}

globalThis.addEventListener("unload", () => {
  abortActiveSession();
});
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
deno test --allow-env src/server/recorder.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/paths.ts src/server/recorder.ts src/server/recorder.test.ts
git commit -m "feat: port recorder session orchestration to Deno.Command"
```

---

### Task 5: Server functions and SSE route

**Files:**
- Create: `src/server/functions.ts`
- Create: `src/routes/api/recorder-events.ts`

**Interfaces:**
- Consumes: `startRecording`, `stopRecording` from `./recorder.ts` (Task 4); `subscribe`, `unsubscribe` from `../../server/events.ts` (Task 3).
- Produces: `export const startRecordingFn`, `export const stopRecordingFn` (both `createServerFn` instances) — Task 6's UI consumes these. Also produces the `GET /api/recorder-events` HTTP endpoint that Task 6's UI subscribes to via `EventSource`.

- [ ] **Step 1: Create `src/server/functions.ts`**

```ts
import { createServerFn } from "@tanstack/react-start";
import { startRecording, stopRecording } from "./recorder.ts";

type StartInput = { sat: string; gain: string; device: number };

export const startRecordingFn = createServerFn({ method: "POST" })
  .validator((data: StartInput) => data)
  .handler(async ({ data }) => {
    return await startRecording(data.sat, data.gain, data.device);
  });

export const stopRecordingFn = createServerFn({ method: "POST" }).handler(async () => {
  return await stopRecording();
});
```

- [ ] **Step 2: Create `src/routes/api/recorder-events.ts`**

```ts
import { createFileRoute } from "@tanstack/react-router";
import { subscribe, unsubscribe } from "../../server/events.ts";

export const Route = createFileRoute("/api/recorder-events")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        let ctrl: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            ctrl = controller;
            subscribe(controller);
          },
          cancel() {
            unsubscribe(ctrl);
          },
        });

        request.signal.addEventListener("abort", () => {
          unsubscribe(ctrl);
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        });
      },
    },
  },
});
```

- [ ] **Step 3: Verify the project still type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors. (There's no dedicated unit test here — `functions.ts` and the SSE route are thin wiring over already-tested `recorder.ts`/`events.ts`, and exercising them for real requires a running HTTP server + `rtl_fm`, which Task 7's manual verification covers.)

- [ ] **Step 4: Commit**

```bash
git add src/server/functions.ts src/routes/api/recorder-events.ts
git commit -m "feat: add startRecording/stopRecording server functions and SSE route"
```

---

### Task 6: Port the UI to server functions + EventSource

**Files:**
- Modify: `src/routes/index.tsx` (replaces the Task 1 placeholder)

**Interfaces:**
- Consumes: `startRecordingFn`, `stopRecordingFn` from `../server/functions.ts` (Task 5); subscribes to `GET /api/recorder-events` (Task 5) via `EventSource`.

- [ ] **Step 1: Replace `src/routes/index.tsx`**

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { startRecordingFn, stopRecordingFn } from "../server/functions";

type LinePayload = { start_line: number; width: number; count: number; pixels_b64: string };
type FinalPayload = { data_url: string };
type StatusPayload = { state: string; message: string; elapsed_secs: number };

const SATS = [
  { id: "15", label: "NOAA-15 · 137.620 MHz" },
  { id: "18", label: "NOAA-18 · 137.9125 MHz" },
  { id: "19", label: "NOAA-19 · 137.100 MHz" },
];

const CANVAS_WIDTH = 2080;

function fmtElapsed(s: number) {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

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

  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState("Idle — pick a satellite and press Record.");
  const [statusState, setStatusState] = useState("idle");
  const [elapsed, setElapsed] = useState(0);
  const [lines, setLines] = useState(0);
  const [finalUrl, setFinalUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  function ensureHeight(h: number) {
    const cv = canvasRef.current!;
    const ctx = ctxRef.current!;
    if (cv.height >= h) return;
    const prev = cv.height > 0 ? ctx.getImageData(0, 0, cv.width, cv.height) : null;
    cv.height = h + 240;
    if (prev) ctx.putImageData(prev, 0, 0);
  }

  function drawRows(p: LinePayload) {
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
    const wrap = wrapRef.current;
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
  }

  function resetCanvas() {
    const cv = canvasRef.current;
    const ctx = ctxRef.current;
    if (!cv || !ctx) return;
    cv.height = 0;
    ctx.clearRect(0, 0, cv.width, cv.height);
  }

  useEffect(() => {
    const cv = canvasRef.current!;
    cv.width = CANVAS_WIDTH;
    cv.height = 0;
    ctxRef.current = cv.getContext("2d");

    const source = new EventSource("/api/recorder-events");
    source.addEventListener("apt-line", (e) => {
      const payload: LinePayload = JSON.parse((e as MessageEvent).data);
      drawRows(payload);
      setLines(payload.start_line + payload.count);
    });
    source.addEventListener("apt-final", (e) => {
      const payload: FinalPayload = JSON.parse((e as MessageEvent).data);
      setFinalUrl(payload.data_url);
    });
    source.addEventListener("apt-status", (e) => {
      const payload: StatusPayload = JSON.parse((e as MessageEvent).data);
      setStatus(payload.message);
      setStatusState(payload.state);
      setElapsed(payload.elapsed_secs);
      if (payload.state === "stopped") setRecording(false);
    });

    return () => source.close();
  }, []);

  async function start() {
    setError(null);
    setFinalUrl(null);
    setLines(0);
    resetCanvas();
    try {
      await startRecordingFn({ data: { sat, gain, device: Number(device) } });
      setRecording(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function stop() {
    try {
      await stopRecordingFn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRecording(false);
    }
  }

  return (
    <main className="app">
      <header className="topbar">
        <h1>🛰️ satelita — NOAA APT live</h1>
        <div className={`status ${statusState}`}>
          {recording && <span className="dot" />}
          <span>{status}</span>
          {recording && <span className="elapsed">{fmtElapsed(elapsed)}</span>}
        </div>
      </header>

      <section className="controls">
        <label>
          Satellite
          <select value={sat} onChange={(e) => setSat(e.target.value)} disabled={recording}>
            {SATS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Gain (dB)
          <input
            value={gain}
            onChange={(e) => setGain(e.target.value)}
            disabled={recording}
            placeholder="45 or agc"
          />
        </label>
        <label>
          Device
          <input
            value={device}
            onChange={(e) => setDevice(e.target.value)}
            disabled={recording}
            style={{ width: "3rem" }}
          />
        </label>
        {!recording ? (
          <button className="rec" onClick={start}>
            ● Record
          </button>
        ) : (
          <button className="stop" onClick={stop}>
            ■ Stop
          </button>
        )}
        <span className="counter">{lines} lines</span>
      </section>

      {error && <div className="error">⚠ {error}</div>}

      <section className="viewport" ref={wrapRef}>
        <canvas ref={canvasRef} className="apt" style={{ display: finalUrl ? "none" : "block" }} />
        {finalUrl && (
          <div className="final">
            <div className="final-label">Final image (satdump — calibrated)</div>
            <img className="apt" src={finalUrl} alt="Final APT image" />
          </div>
        )}
        {lines === 0 && !finalUrl && (
          <div className="placeholder">
            {recording
              ? "Waiting for the first decoded lines… the image builds top-to-bottom in real time."
              : "No image yet. Start a recording when the satellite is above the horizon."}
          </div>
        )}
      </section>
    </main>
  );
}
```

- [ ] **Step 2: Type-check and boot-verify**

```bash
npx tsc --noEmit
npm run dev &
sleep 3
curl -s http://localhost:1420/ | grep -o "satelita — NOAA APT live"
kill %1
```

Expected: no type errors, and the curl output prints `satelita — NOAA APT live`, confirming the ported UI renders through the TanStack Start server route.

- [ ] **Step 3: Commit**

```bash
git add src/routes/index.tsx
git commit -m "feat: port UI to server functions and SSE (EventSource)"
```

---

### Task 7: Packaging polish and final verification

**Files:**
- Modify: `README.md`

**Interfaces:** None — this task doesn't add new exports, it verifies and documents the whole app.

- [ ] **Step 1: Replace `README.md`**

```markdown
# satelita

A desktop app for live-decoding NOAA weather-satellite APT transmissions
from an RTL-SDR dongle. Built with [TanStack Start](https://tanstack.com/start)
and packaged as a native app with [`deno desktop`](https://docs.deno.com/runtime/desktop/).

## Requirements

- [Deno](https://deno.com/) 2.9+
- `rtl_fm`, `sox`, and `satdump` on `PATH`
- An RTL-SDR dongle

## Development

\`\`\`bash
npm install
deno task dev
\`\`\`

Opens a native window against the TanStack Start dev server with hot reload.

## Build

\`\`\`bash
npm run build
deno task build
\`\`\`

Produces a native installer under `dist/` for the current platform.
```

- [ ] **Step 2: Run the full test suite**

```bash
deno task test
```

Expected: all tests in `src/server/` pass (from Tasks 2–4).

- [ ] **Step 3: Full project type-check and production build**

```bash
npx tsc --noEmit
npm run build
```

Expected: no type errors; `npm run build` completes and produces `.output/`.

- [ ] **Step 4: Manual verification (requires the `deno` CLI, a GUI session, and — for full end-to-end confidence — real SDR hardware; not something an automated/headless step can confirm)**

```bash
deno --version   # confirm 2.9+
deno task dev
```

Checklist for whoever runs this locally:
- A native window opens showing the satelita UI (not a browser tab).
- Selecting a satellite and pressing "Record" starts `rtl_fm` (check `ps` or the recordings directory under the OS-appropriate app-data path from `src/server/paths.ts`).
- Decoded lines appear live in the canvas.
- "Stop" halts `rtl_fm`, and a final `satdump`-decoded image eventually replaces the canvas.
- Closing the window mid-recording doesn't leave an orphaned `rtl_fm` process running (verifies `abortActiveSession`'s `unload` listener).
- `deno task build` produces a working native installer for your platform.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: update README for the TanStack Start / deno desktop stack"
```

---

## Self-Review Notes

- **Spec coverage:** every component listed in the design spec's component table maps to a task (apt-decoder.ts → Task 2, events.ts → Task 3, recorder.ts → Task 4, functions.ts + SSE route → Task 5, index.tsx → Task 6). The two "open implementation risks" from the spec (deno desktop permission config, SSE-through-webview) are called out explicitly in Task 1's note and Task 7's manual verification.
- **Type consistency:** `LinePayload`/`StatusPayload`/`FinalPayload` shapes are identical across `recorder.ts` (Task 4, what gets broadcast) and `index.tsx` (Task 6, what gets parsed) — both use `start_line`/`width`/`count`/`pixels_b64`, `state`/`message`/`elapsed_secs`, `data_url`. `AptDecoder.linesOut`/`.process()` (Task 2) match their usage in `recorder.ts` (Task 4). `startRecordingFn`/`stopRecordingFn` (Task 5) match their call sites in `index.tsx` (Task 6).
- **No placeholders:** every step has complete, runnable code — no TODOs or "similar to Task N" shortcuts.
