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
