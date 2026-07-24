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
