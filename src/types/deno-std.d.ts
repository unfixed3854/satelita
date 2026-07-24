// Ambient type declarations for the JSR (`@std/*`) modules used by
// `src/server/**`. Plain `tsc` (unlike `deno check`) has no built-in
// resolver for `jsr:` specifiers, so these mirror the real, published
// signatures (see https://jsr.io/@std/assert and
// https://jsr.io/@std/encoding) just enough for the call sites in this
// project to type-check accurately — not stubbed out as `any`.
//
// This file is additive infrastructure for the type-checker only; it does
// not change any runtime behavior (Deno resolves the real `@std/*` packages
// via the `imports` map in `deno.json`, independent of this file).

declare module "@std/assert" {
  /** Make an assertion, throwing an `AssertionError` if `expr` is falsy. */
  export function assert(expr: unknown, msg?: string): asserts expr;

  /** Make an assertion that `actual` and `expected` are deeply equal, throwing otherwise. */
  export function assertEquals<T>(actual: T, expected: T, msg?: string): void;
}

declare module "@std/encoding/base64" {
  /** Encode binary data (or a string) into a base64-encoded string. */
  export function encodeBase64(data: ArrayBuffer | Uint8Array | string): string;

  /** Decode a base64-encoded string into binary data. */
  export function decodeBase64(b64: string): Uint8Array;
}
