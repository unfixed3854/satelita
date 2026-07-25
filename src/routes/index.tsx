import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  // A plain useRef object only runs setup once — the first time a *specific*
  // DOM node is assigned to it. ImageStage unmounts the canvas whenever the
  // stage switches away from live (to show a finished recording's <img>
  // instead) and mounts a brand-new element when it switches back; that new
  // node never got width/height set or its 2D context captured, leaving
  // drawRows writing into a detached canvas that renders solid black. A ref
  // whose `current` setter does the setup work runs on every mount, not
  // just the first — and reads of `.current` (what ImageStage's save()
  // does) still return the live node, so ImageStage itself needs no
  // changes.
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  const canvasRef = useMemo<React.RefObject<HTMLCanvasElement | null>>(() => ({
    get current() {
      return canvasElRef.current;
    },
    set current(node: HTMLCanvasElement | null) {
      canvasElRef.current = node;
      if (node) {
        node.width = APT_LINE_WIDTH;
        node.height = 0;
        ctxRef.current = node.getContext("2d");
      } else {
        ctxRef.current = null;
      }
    },
  }), []);

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

    // Captured *before* ensureHeight grows the canvas. ensureHeight always
    // leaves 240 blank rows below the newest line, and at typical window
    // sizes those scale up to well over the 80px "close enough" threshold
    // below — reading atBottom afterward would read false forever once a
    // pass's image exceeds the viewport (~10 minutes in), silently turning
    // auto-follow off for the rest of the pass.
    const wrap = wrapRef.current;
    const atBottom = wrap
      ? wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80
      : false;

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
    if (wrap && atBottom) wrap.scrollTop = wrap.scrollHeight;
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
    void refreshRecordings();
  }, [refreshRecordings]);

  // Set right before every startRecordingFn call and checked right after it
  // resolves (see start() below) — guards against a race where the SSE
  // "idle" frame for an instant rtl_fm failure lands before the POST's
  // response settles. Without this, start()'s own setPhase("recording")
  // would run *after* the crash was already correctly reported, pinning the
  // chip to RECORDING permanently and making Stop throw "Not recording."
  const terminalSeenRef = useRef(false);

  // The server can fail a pass after start already succeeded — e.g. rtl_fm
  // rejecting a device that doesn't exist, or crashing mid-pass with
  // nothing worth decoding. That surfaces as an apt-status broadcast
  // straight to "idle" (recording -> decoding -> stopped is the only other
  // path, so this transition is unambiguous), carrying the failure in
  // `message`. Route it into the dismissible error banner rather than
  // state.message: reset()'s "keep the previous message" behavior is for
  // the start/stop try/catch paths below, not for this.
  const prevPhaseRef = useRef(state.phase);
  useEffect(() => {
    if (prevPhaseRef.current === "recording" && state.phase === "idle") {
      setError(state.message);
      terminalSeenRef.current = true;
      // A crash with nothing captured still creates a new (aborted-looking)
      // recording directory on disk — refresh so it shows up without a
      // manual reload.
      void refreshRecordings();
    }
    prevPhaseRef.current = state.phase;
  }, [state.phase, state.message, refreshRecordings]);

  // Refresh the recordings list on every terminal "stopped" phase, not only
  // via state.finishedId below — finishedId never fires when finalDecode
  // produces no png (too little was captured to decode), which otherwise
  // silently left the just-finished run out of the sidebar until a reload.
  useEffect(() => {
    if (state.phase !== "stopped") return;
    void refreshRecordings();
  }, [state.phase, refreshRecordings]);

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
    terminalSeenRef.current = false;
    setSource({ kind: "live" });
    try {
      await startRecordingFn({ data: { sat, gain, device: Number(device) } });
      // Only if the SSE stream hasn't already reported this exact attempt
      // as failed — see terminalSeenRef's declaration above.
      if (!terminalSeenRef.current) setPhase("recording");
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
