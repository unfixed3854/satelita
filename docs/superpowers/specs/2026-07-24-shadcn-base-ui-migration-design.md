# Migrate satelita's UI to shadcn/ui (Base UI)

Date: 2026-07-24

## Context

`satelita`'s entire UI is one route (`src/routes/index.tsx`) plus one
hand-written stylesheet (`src/app.css`): a custom dark GitHub-style palette
defined as raw CSS custom properties, and BEM-ish classes (`.topbar`,
`.controls`, `.error`, `.viewport`, `.meta`, …) for layout and controls. There
is no Tailwind CSS and no component library today.

Goal: migrate this hand-rolled UI onto [shadcn/ui](https://ui.shadcn.com),
using [Base UI](https://base-ui.com) as the underlying headless primitives
library — shadcn/ui switched its default from Radix UI to Base UI this month
(July 2026), while continuing to support Radix. shadcn/ui ships an official
TanStack Start integration, and its CLI can configure Tailwind, path
aliases, and component scaffolding against an existing project rather than
requiring a fresh scaffold.

This is a chrome/markup/styling migration only. The APT decode pipeline
(canvas drawing, SSE stream handling, `startRecordingFn`/`stopRecordingFn`
server functions) is unrelated and untouched.

## Decisions

- **Theme**: adopt shadcn/ui's stock default theme rather than reproducing
  the app's current custom palette (`--bg`, `--panel`, `--accent`, etc.).
  Those custom properties and all classes built on them in `src/app.css`
  are removed.
- **Style/preset**: `nova` — the shadcn/ui CLI's own current default
  preset (`--preset nova`), used in its Base UI flavor (`--base base`,
  which the CLI writes into `components.json` as `"style": "base-nova"`).

  (Verified against the live CLI, superseding earlier doc research done
  during brainstorming: `shadcn init` no longer offers a "style: new-york
  + base color: zinc" prompt flow — it now offers 8 fixed presets `nova`/
  `vega`/`maia`/`lyra`/`mira`/`luma`/`sera`/`rhea`, each available in a
  Radix or Base UI flavor via the `style` string itself, e.g. `base-nova`
  vs `radix-nova`. `components.json` has no separate `"base"` field. The
  legacy `"style": "new-york"` value still exists but only ever installs
  Radix components — there is no Base UI variant registered under it, so
  it's incompatible with the Base UI requirement. `nova`'s default color
  is `"neutral"`, a zero-chroma gray distinct from `zinc` — since `nova`
  is the CLI's actual current default, using its default color satisfies
  "shadcn's stock default theme" more literally than the `zinc` guess
  made earlier.)
- **Base library**: Base UI (`--base base`).
- **Dark mode**: stays dark-only, matching current behavior. No light/dark
  toggle is introduced (out of scope). Forced by adding `className="dark"`
  to the `<html>` element in `src/routes/__root.tsx`, which activates
  shadcn/ui's dark CSS variables.
- **Package manager**: npm, matching the project's existing
  `package-lock.json` and `npm run dev`/`npm run build` scripts (the Deno
  tasks in `deno.json` just wrap these).

## Tooling setup

1. `npx shadcn@latest init --preset nova --base base` against the existing
   Vite + TanStack Start project. Expected to auto-detect the framework and:
   - Install Tailwind CSS v4 and its Vite plugin, wiring it into
     `vite.config.ts`
   - Add the `@/*` path alias to `tsconfig.json`
   - Write `components.json` (`style: "base-nova"`,
     `tailwind.baseColor: "neutral"`, `tailwind.cssVariables: true`)
   - Add `src/lib/utils.ts` (the `cn` class-merging helper)
   - Rewrite `src/app.css` to `@import "tailwindcss"` plus shadcn/ui's
     generated `nova`-preset theme CSS variables (semantic variable names —
     `--background`, `--foreground`, `--primary`, `--destructive`,
     `--muted-foreground`, `--border`, etc. — are the same across every
     preset, so downstream component code isn't preset-specific)
2. `npx shadcn@latest add button select input label badge alert` to
   scaffold the needed primitives into `src/components/ui/`.

If CLI auto-detection of this project's Vite + TanStack Start setup doesn't
fully succeed (e.g. it can't find the Tailwind entry CSS or path alias
automatically), the fallback is the manual steps from shadcn/ui's Vite
installation guide, applied by hand to the same end state described above.

## Component mapping (`src/routes/index.tsx`)

| Current (`app.css` class) | Becomes |
|---|---|
| `.topbar .status` text + `.dot` | `<Badge>` (variant reflects idle/recording/stopped state) with a small `animate-pulse` dot (Tailwind's built-in utility — replaces the current custom `@keyframes pulse`) |
| `.controls label` + `select`/`input` | `<Label>` + `<Select>` (satellite) and `<Label>` + `<Input>` (gain, device) |
| `.controls .rec` / `.controls .stop` buttons | `<Button>` — `default` variant for Record, `destructive` variant for Stop |
| `.error` | `<Alert variant="destructive">` |
| `.viewport`, `.apt`, `.final`, `.final-label`, `.placeholder` | Plain `div`/`img`/`canvas` elements laid out with Tailwind utility classes; canvas pixelation moves from a CSS rule to an inline `style={{ imageRendering: "pixelated" }}` |
| `.counter`, `.meta` | Tailwind-only muted text, no custom classes |

No new components beyond `button`, `select`, `input`, `label`, `badge`,
`alert` are needed — the route has no other distinct UI patterns.

## File-level changes

- `vite.config.ts`, `tsconfig.json` — updated by `shadcn init` (Tailwind
  plugin, `@/*` path alias)
- `src/app.css` — replaced with Tailwind import + shadcn/ui's generated
  theme variables; all current custom classes removed
- `src/routes/__root.tsx` — add `dark` class to `<html>`
- `src/routes/index.tsx` — rewritten to use the shadcn/ui components above
  plus Tailwind utility classes for layout; no change to state, effects, or
  data flow
- New: `components.json`, `src/lib/utils.ts`,
  `src/components/ui/{button,select,input,label,badge,alert}.tsx`

## Testing

- `npm run build` (`vite build && tsc --noEmit`) for build and type
  correctness.
- Manual check in the browser dev preview (`deno task dev`): Record/Stop
  toggling, satellite/gain/device controls (including `disabled` state while
  recording), the error alert path, and live APT line rendering plus the
  final-image swap, all still work visually and functionally.
