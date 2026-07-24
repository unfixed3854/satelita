# shadcn/ui (Base UI) Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace satelita's hand-written CSS UI (`src/routes/index.tsx` +
`src/app.css`) with shadcn/ui components built on Base UI, per
[docs/superpowers/specs/2026-07-24-shadcn-base-ui-migration-design.md](../specs/2026-07-24-shadcn-base-ui-migration-design.md).

**Architecture:** `npx shadcn@latest init` configures Tailwind CSS v4 +
Base UI tooling against the existing Vite/TanStack Start project (path
alias, `components.json`, `cn` util, theme CSS). `npx shadcn@latest add`
scaffolds the individual component primitives into `src/components/ui/`.
The single route's JSX is then rewritten to use those components with
Tailwind utility classes instead of the current custom CSS classes. No
state, effects, SSE handling, or server-function logic changes.

**Tech Stack:** TanStack Start (Vite + React 19 + TanStack Router),
Tailwind CSS v4, shadcn/ui CLI, Base UI, TypeScript, npm.

## Global Constraints

- Package manager: npm (matches existing `package-lock.json` and
  `npm run dev`/`npm run build`, which the Deno tasks in `deno.json` wrap).
- shadcn/ui style: `new-york`.
- shadcn/ui base library: Base UI (`base: "base"` — shadcn/ui's current
  default; no non-standard flag needed).
- Theme: shadcn/ui's stock default (zinc-based) CSS variables. Do not
  reproduce the old `--bg`/`--panel`/`--accent`/`--danger` palette.
- Dark mode: dark-only, forced via `className="dark"` on `<html>` in
  `src/routes/__root.tsx`. No light/dark toggle UI.
- Only these shadcn/ui components are needed: `button`, `select`, `input`,
  `label`, `badge`, `alert`. Do not add others.
- The APT decode pipeline, SSE wiring, and `startRecordingFn`/
  `stopRecordingFn` calls in `src/routes/index.tsx` must be preserved
  exactly as-is — only the returned JSX and its imports change.
- No automated UI test framework exists in this repo (the only tests are
  `src/server/*.test.ts`, run via `deno test`, unrelated to the UI).
  Verification for this plan is `npm run build` (type/build correctness)
  plus manual browser checks — do not invent UI unit tests that don't fit
  the existing setup.

## File Structure

- `vite.config.ts` — modify: add Tailwind CSS v4 Vite plugin (written by
  `shadcn init`)
- `tsconfig.json` — modify: add `@/*` path alias (written by `shadcn init`)
- `components.json` — create: shadcn/ui config (`style: new-york`,
  `base: base`, `cssVariables: true`)
- `src/lib/utils.ts` — create: `cn()` class-merging helper
- `src/app.css` — modify: replace custom CSS with `@import "tailwindcss"` +
  shadcn/ui's generated theme variables; obsolete custom classes removed
  in Task 4
- `src/components/ui/{button,select,input,label,badge,alert}.tsx` —
  create: shadcn/ui component primitives
- `src/routes/__root.tsx` — modify: force dark mode
- `src/routes/index.tsx` — modify: JSX rewritten to use the new components

---

### Task 1: Initialize shadcn/ui + Tailwind v4 + Base UI tooling

**Files:**
- Modify: `vite.config.ts`, `tsconfig.json`, `src/app.css`
- Create: `components.json`, `src/lib/utils.ts`

**Interfaces:**
- Produces: `@/*` import alias resolving to `src/*`; `cn(...)` export from
  `src/lib/utils.ts`; `components.json` with `style: "new-york"`,
  `"base": "base"`, `tailwind.cssVariables: true`, consumed by Task 2's
  `shadcn add` calls.

- [ ] **Step 1: Run the shadcn init CLI**

Run:

```bash
npx shadcn@latest init --yes --template start --base base
```

Answer any remaining interactive prompts with the defaults (style:
new-york, base color: zinc, CSS variables: yes) if the `--yes`/`--template`
flags don't suppress all of them.

- [ ] **Step 2: Verify `components.json` matches the required config**

Read `components.json` and confirm it contains:

```json
{
  "style": "new-york",
  "base": "base",
  "tailwind": {
    "cssVariables": true
  }
}
```

(Exact key layout may differ slightly by CLI version — the three values
above are what matter.) If `style` or `base` don't match, edit
`components.json` directly to fix them now, before any components are
added — the style/base can't be changed retroactively once components
exist in `src/components/ui/`.

- [ ] **Step 3: Verify the path alias and Tailwind wiring**

Read `tsconfig.json` and confirm a `paths` entry maps `"@/*"` to
`"./src/*"`. Read `vite.config.ts` and confirm a Tailwind CSS Vite plugin
(e.g. `@tailwindcss/vite`) is registered in the `plugins` array alongside
the existing `tanstackStart`/`viteReact`/`nitro` plugins. Read
`src/app.css` and confirm it starts with `@import "tailwindcss";` followed
by a `:root`/`.dark` block of shadcn/ui CSS variables (`--background`,
`--foreground`, `--primary`, etc.) — the file's original custom classes
(`.topbar`, `.controls`, etc.) may still be present below this; that's
expected and gets cleaned up in Task 4.

If any of these three are missing, apply them by hand following
[shadcn/ui's Vite manual installation guide](https://ui.shadcn.com/docs/installation/vite),
targeting the same end state described above.

- [ ] **Step 4: Confirm the project still builds**

Run: `npm run build`
Expected: succeeds (vite build + `tsc --noEmit` both pass) — the app's
runtime behavior hasn't changed yet, only tooling/config.

- [ ] **Step 5: Commit**

```bash
git add vite.config.ts tsconfig.json components.json src/lib/utils.ts src/app.css package.json package-lock.json
git commit -m "chore: initialize shadcn/ui with Tailwind v4 and Base UI"
```

---

### Task 2: Add shadcn/ui component primitives

**Files:**
- Create: `src/components/ui/button.tsx`, `src/components/ui/select.tsx`,
  `src/components/ui/input.tsx`, `src/components/ui/label.tsx`,
  `src/components/ui/badge.tsx`, `src/components/ui/alert.tsx`

**Interfaces:**
- Consumes: `components.json` from Task 1 (determines style/base used to
  generate these files) and `cn()` from `src/lib/utils.ts`.
- Produces: `Button` (`@/components/ui/button`, prop `variant`, at least
  `"default"` and `"destructive"`), `Select`/`SelectTrigger`/`SelectValue`/
  `SelectContent`/`SelectItem` (`@/components/ui/select`), `Input`
  (`@/components/ui/input`), `Label` (`@/components/ui/label`), `Badge`
  (`@/components/ui/badge`, prop `variant`, at least `"default"`/
  `"secondary"`/`"outline"`), `Alert`/`AlertDescription`
  (`@/components/ui/alert`, prop `variant` including `"destructive"`) —
  all consumed by Task 3.

- [ ] **Step 1: Run the shadcn add CLI**

Run:

```bash
npx shadcn@latest add button select input label badge alert --yes
```

- [ ] **Step 2: Verify the component files exist**

Run: `ls src/components/ui/`
Expected: `button.tsx`, `select.tsx`, `input.tsx`, `label.tsx`,
`badge.tsx`, `alert.tsx` (plus any additional files those components
depend on, e.g. icon or portal helpers the CLI pulls in automatically).

- [ ] **Step 3: Confirm the project still builds**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/components/ui package.json package-lock.json
git commit -m "chore: add shadcn/ui button, select, input, label, badge, and alert"
```

---

### Task 3: Force dark mode and rewrite the control panel with shadcn/ui components

**Files:**
- Modify: `src/routes/__root.tsx:23` (the `<html>` element)
- Modify: `src/routes/index.tsx` (imports and the `App` component's
  returned JSX only — no other changes)

**Interfaces:**
- Consumes: `Button`, `Select`/`SelectTrigger`/`SelectValue`/
  `SelectContent`/`SelectItem`, `Input`, `Label`, `Badge`, `Alert`/
  `AlertDescription` from Task 2.

- [ ] **Step 1: Force dark mode on the root document**

In `src/routes/__root.tsx`, change:

```tsx
    <html lang="en">
```

to:

```tsx
    <html lang="en" className="dark">
```

- [ ] **Step 2: Replace the imports at the top of `src/routes/index.tsx`**

Replace:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { startRecordingFn, stopRecordingFn } from "../server/functions";
```

with:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { startRecordingFn, stopRecordingFn } from "../server/functions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
```

- [ ] **Step 3: Add a status-to-badge-variant helper**

Directly below the existing `fmtElapsed` function (before `b64ToBytes`),
add:

```tsx
function badgeVariant(state: string): "default" | "secondary" | "outline" {
  if (state === "recording") return "default";
  if (state === "stopped") return "outline";
  return "secondary";
}
```

- [ ] **Step 4: Replace the `App` component's returned JSX**

Replace the entire `return (...)` block at the end of `App` (currently
starting at `<main className="app">` and ending at the matching `</main>`)
with:

```tsx
  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-center gap-4 border-b p-4">
        <h1 className="text-base font-semibold">🛰️ satelita — NOAA APT live</h1>
        <div className="ml-auto flex items-center gap-2">
          {recording && <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-destructive" />}
          <Badge variant={badgeVariant(statusState)}>{status}</Badge>
          {recording && <span className="font-semibold tabular-nums">{fmtElapsed(elapsed)}</span>}
        </div>
      </header>

      <section className="flex flex-wrap items-end gap-4 border-b p-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sat">Satellite</Label>
          <Select value={sat} onValueChange={setSat} disabled={recording}>
            <SelectTrigger id="sat" className="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SATS.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="gain">Gain (dB)</Label>
          <Input
            id="gain"
            value={gain}
            onChange={(e) => setGain(e.target.value)}
            disabled={recording}
            placeholder="45 or agc"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="device">Device</Label>
          <Input
            id="device"
            className="w-12"
            value={device}
            onChange={(e) => setDevice(e.target.value)}
            disabled={recording}
          />
        </div>
        {!recording ? (
          <Button onClick={start}>● Record</Button>
        ) : (
          <Button variant="destructive" onClick={stop}>
            ■ Stop
          </Button>
        )}
        <span className="text-xs text-muted-foreground tabular-nums">{lines} lines</span>
      </section>

      {error && (
        <Alert variant="destructive" className="mx-4 mt-3 w-auto">
          <AlertDescription>⚠ {error}</AlertDescription>
        </Alert>
      )}

      <section className="flex flex-1 items-start justify-center overflow-auto p-4" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="w-full border bg-black"
          style={{ display: finalUrl ? "none" : "block", imageRendering: "pixelated" }}
        />
        {finalUrl && (
          <div className="w-full">
            <div className="mb-1.5 text-sm font-medium">Final image (satdump — calibrated)</div>
            <img
              className="w-full border bg-black"
              style={{ imageRendering: "pixelated" }}
              src={finalUrl}
              alt="Final APT image"
            />
          </div>
        )}
        {lines === 0 && !finalUrl && (
          <div className="mt-12 max-w-[420px] text-center text-muted-foreground">
            {recording
              ? "Waiting for the first decoded lines… the image builds top-to-bottom in real time."
              : "No image yet. Start a recording when the satellite is above the horizon."}
          </div>
        )}
      </section>
    </main>
  );
```

- [ ] **Step 5: Confirm the project builds**

Run: `npm run build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/routes/__root.tsx src/routes/index.tsx
git commit -m "feat: rewrite control panel UI with shadcn/ui components"
```

---

### Task 4: Remove obsolete hand-written CSS

**Files:**
- Modify: `src/app.css`

**Interfaces:**
- Consumes: nothing new — this only deletes CSS that Task 3 made
  unreferenced.

- [ ] **Step 1: Confirm nothing still references the old classes**

Run:

```bash
grep -on 'className="[^"]*"' src/routes/index.tsx src/routes/__root.tsx
```

Expected: none of the old class names (`app`, `topbar`, `status`,
`recording`, `stopped`, `dot`, `controls`, `rec`, `stop`, `error`,
`viewport`, `apt`, `counter`, `final`, `final-label`, `placeholder`,
`meta`) appear in the output.

- [ ] **Step 2: Delete the obsolete rules from `src/app.css`**

Remove every rule below the `@import "tailwindcss";` line and the
shadcn/ui-generated theme variable block (`:root { ... }` / `.dark { ... }`
and any `@theme inline { ... }` block shadcn/ui added) — i.e. delete the
old `:root` color-token block and every class rule (`*`, `body`, `.app`,
`.topbar`, `.topbar h1`, `.status`, `.status.recording`, `.status.stopped`,
`.status .elapsed`, `.dot`, `@keyframes pulse`, `.controls`,
`.controls label`, `.controls select, .controls input`, `.controls button`,
`.controls .rec`, `.controls .stop`, `.error`, `.viewport`, `.apt`,
`.counter`, `.final`, `.final-label`, `.placeholder`, `.meta`). The file
should end up containing only the Tailwind import and the shadcn/ui theme
variables that `shadcn init` generated in Task 1.

- [ ] **Step 3: Confirm the project builds**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/app.css
git commit -m "chore: remove obsolete hand-written CSS"
```

---

### Task 5: Manual browser verification

**Files:** none (verification only, no commit)

- [ ] **Step 1: Start the dev server**

Use the `run` skill or `deno task dev`, then open the app at
`http://localhost:1420` in the browser preview.

- [ ] **Step 2: Check the base layout and dark theme**

Take a screenshot. Confirm: the page renders in dark mode (shadcn/ui's
dark theme, not the old GitHub-dark palette), the header/badge/controls
row/viewport are laid out as in the design, and there are no console
errors.

- [ ] **Step 3: Exercise the controls**

Open the Satellite `<Select>` and confirm all three options
(NOAA-15/18/19) are selectable. Type into the Gain and Device `<Input>`s
and confirm the values update. Click **● Record**.

- [ ] **Step 4: Verify the error path**

If `rtl_fm`/`sox`/`satdump` aren't available in this environment, clicking
Record is expected to fail — confirm the red destructive `<Alert>` appears
with the error message, and that the Satellite/Gain/Device controls become
enabled again (recording state resets to `false`). If those binaries *are*
available and a recording actually starts, instead confirm: the controls
become disabled, the badge switches to the "recording" variant with the
pulsing dot and elapsed timer, and clicking **■ Stop** ends the session
cleanly.

- [ ] **Step 5: Report results**

Summarize what was verified and attach the screenshot(s). No commit — this
task is verification-only. If any step surfaces a bug, fix it as a new
follow-up step in the relevant earlier task (Task 3 for JSX/logic issues,
Task 4 for leftover CSS) and re-verify, rather than patching around it here.
