// Shared numeric constants with no side effects, so read-only modules (like
// recordings.ts) can depend on them without pulling in recorder.ts's
// process-spawning machinery.

/** rtl_fm FM-demod output rate — also the DSP rate, and the divisor that
 * turns a recording's signal.raw byte count back into its duration. */
export const CAPTURE_RATE = 60_000;
