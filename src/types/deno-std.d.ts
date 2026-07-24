// Ambient type declarations for the JSR (`@std/*`) modules used by
// `src/server/**`'s test files. Plain `tsc` (unlike `deno check`) has no
// built-in resolver for `jsr:` specifiers, so this mirrors the real,
// published signature (see https://jsr.io/@std/assert) just enough for the
// call sites in this project to type-check accurately — not stubbed out as
// `any`.
//
// This file is additive infrastructure for the type-checker only; it does
// not change any runtime behavior (Deno resolves the real `@std/assert`
// package via the `imports` map in `deno.json`, independent of this file).

declare module "@std/assert" {
  /** Make an assertion, throwing an `AssertionError` if `expr` is falsy. */
  export function assert(expr: unknown, msg?: string): asserts expr;

  /** Make an assertion that `actual` and `expected` are deeply equal, throwing otherwise. */
  export function assertEquals<T>(actual: T, expected: T, msg?: string): void;
}
