import { useEffect, useRef } from "react";

import { SIGNAL_HISTORY } from "@/hooks/use-recorder-events";
import { readToken } from "@/lib/theme";

/** Peak level above which the front end is effectively clipping and the
 * pass is being quietly ruined.
 *
 * Thresholded on *peak*, never RMS. A saturated front end pins peak at
 * ~1.0 while RMS stays far below — reaching an RMS of 0.95 on a [-1, 1]
 * signal takes a near-square wave, which APT audio never is — so an
 * RMS-based test would leave this warning permanently dark. */
const CLIP_THRESHOLD = 0.95;

/**
 * Sync score thresholds for the lock-state readout.
 *
 * An SNR sweep showed the sync metric is a lock detector, not a graduated
 * quality meter: score sits at ~1.0 while locked, falls through a narrow
 * band, then bottoms out at 0.0 once lock is lost — there is no smooth
 * continuum to report as a percentage. The thresholds below turn that
 * cliff into three named states instead of implying resolution the metric
 * doesn't have.
 */
const SYNC_LOCK_THRESHOLD = 0.75;
const SYNC_MARGINAL_THRESHOLD = 0.25;

type SyncLockState = "LOCK" | "MARGINAL" | "NO LOCK";

function syncLockState(score: number): SyncLockState {
  if (score >= SYNC_LOCK_THRESHOLD) return "LOCK";
  if (score >= SYNC_MARGINAL_THRESHOLD) return "MARGINAL";
  return "NO LOCK";
}

/** A scrolling history strip. Values are 0..1, oldest first.
 *
 * `values` is drawn as a filled trace; the optional `overlay` is drawn as a
 * lighter line on the same axes, for a companion series that shares the
 * scale (peak over RMS). */
function Strip({
  values,
  overlay,
  color,
  label,
  readout,
  readoutClassName,
}: {
  values: number[];
  overlay?: number[];
  color: string;
  label: string;
  readout: string;
  readoutClassName: string;
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

    // Peak rides above RMS, so it is drawn last (on top) and unfilled —
    // a thin, half-opacity line reads as a ceiling over the envelope
    // rather than as a second competing trace. Aligned to the right edge
    // by its own length, so a brief mismatch in sample counts between the
    // two series still lines up at the newest sample.
    if (overlay && overlay.length > 0) {
      const ox0 = cssWidth - overlay.length * step;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      overlay.forEach((v, i) => {
        const x = ox0 + i * step;
        if (i === 0) ctx.moveTo(x, yFor(v));
        else ctx.lineTo(x, yFor(v));
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }, [values, overlay, color]);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</span>
        <span className={`font-mono text-[11px] tabular-nums ${readoutClassName}`}>
          {readout}
        </span>
      </div>
      <canvas ref={canvasRef} className="h-10 w-full rounded border border-border bg-black/30" />
    </div>
  );
}

export interface SignalPanelProps {
  /** RMS history — the filled Level trace. */
  level: number[];
  /** Peak history — the lighter overlay, and what CLIP is thresholded on. */
  peak: number[];
  sync: number[];
  lines: number;
  recording: boolean;
}

export function SignalPanel({ level, peak, sync, lines, recording }: SignalPanelProps) {
  const latestLevel = level.at(-1) ?? 0;
  const latestPeak = peak.at(-1) ?? 0;
  const latestSync = sync.at(-1) ?? 0;
  const clipping = latestPeak >= CLIP_THRESHOLD;
  const lockState = syncLockState(latestSync);
  const locked = lockState === "LOCK";

  const signalColor = readToken("--signal", "#4ade80");
  const warnColor = readToken("--signal-warn", "#fbbf24");
  const dimColor = readToken("--signal-dim", "#2f5f43");

  return (
    <div className="flex flex-col gap-3">
      <Strip
        values={level}
        overlay={peak}
        color={clipping ? warnColor : signalColor}
        label="Level"
        readout={clipping ? "CLIP" : latestLevel.toFixed(2)}
        readoutClassName={clipping ? "text-signal-warn" : "text-muted-foreground"}
      />
      <Strip
        values={sync}
        color={locked ? signalColor : dimColor}
        label="Sync lock"
        readout={lockState}
        readoutClassName={
          lockState === "LOCK"
            ? "text-signal"
            : lockState === "MARGINAL"
              ? "text-signal-warn"
              : "text-muted-foreground"
        }
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
