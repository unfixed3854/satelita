import { useEffect, useMemo, useRef, useState } from "react";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import landTopology from "world-atlas/land-110m.json";

import type { GeoPoint, Subpoint } from "@/lib/orbit";
import { project } from "@/lib/projection";
import { subsolarPoint, terminatorLatitude } from "@/lib/terminator";
import { readToken } from "@/lib/theme";

export interface MapSatellite {
  id: string;
  label: string;
  color: string;
  subpoint: Subpoint;
  track: GeoPoint[];
}

export interface WorldMapProps {
  date: Date;
  station: { lat: number; lon: number } | null;
  satellites: MapSatellite[];
}

/** Natural Earth's 110m land at 55KB, decoded once at module load. The
 * data stops at 85.6S, so Antarctica's lower edge is the dataset's edge
 * rather than a projection artefact. */
const LAND = feature(
  landTopology as unknown as Topology<{ land: GeometryCollection }>,
  (landTopology as unknown as Topology<{ land: GeometryCollection }>).objects.land,
);

/** Longitude sampling for the terminator curve. One point per two degrees
 * is smooth at any window size this app runs at. */
const TERMINATOR_STEP_DEG = 2;

/** Reprojecting Natural Earth's coastlines is by far the most expensive
 * thing this component does, and the result depends only on the canvas
 * size — not on the clock. Building it into a Path2D lets the 1 Hz redraw
 * be a single `ctx.fill(path)` instead of several thousand `lineTo` calls
 * a second, every second, for as long as the window is open. */
function buildLandPath(w: number, h: number): Path2D {
  const path = new Path2D();
  for (const f of LAND.features) {
    const geometry = f.geometry;
    if (geometry.type !== "MultiPolygon" && geometry.type !== "Polygon") continue;
    const polygons = geometry.type === "MultiPolygon"
      ? geometry.coordinates
      : [geometry.coordinates];
    for (const polygon of polygons) {
      for (const ring of polygon) {
        ring.forEach(([lon, lat], i) => {
          const { x, y } = project(lat, lon, w, h);
          if (i === 0) path.moveTo(x, y);
          else path.lineTo(x, y);
        });
        path.closePath();
      }
    }
  }
  return path;
}

function drawGraticule(ctx: CanvasRenderingContext2D, w: number, h: number, stroke: string) {
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let lon = -180; lon <= 180; lon += 30) {
    const { x } = project(0, lon, w, h);
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const { y } = project(lat, 0, w, h);
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
}

/** Shades the dark hemisphere by tracing the terminator across the map and
 * closing the path along whichever edge is in darkness — which is what
 * makes polar night fill correctly instead of leaving a gap at the pole. */
function drawNight(ctx: CanvasRenderingContext2D, w: number, h: number, date: Date, fill: string) {
  const sub = subsolarPoint(date);
  ctx.fillStyle = fill;
  ctx.beginPath();

  for (let lon = -180; lon <= 180; lon += TERMINATOR_STEP_DEG) {
    const { x, y } = project(terminatorLatitude(lon, sub), lon, w, h);
    if (lon === -180) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }

  // Northern-summer sun means the south is dark, and vice versa.
  const darkEdgeY = sub.lat >= 0 ? h : 0;
  ctx.lineTo(w, darkEdgeY);
  ctx.lineTo(0, darkEdgeY);
  ctx.closePath();
  ctx.fill();
}

function drawStation(ctx: CanvasRenderingContext2D, w: number, h: number, station: { lat: number; lon: number }, color: string) {
  const { x, y } = project(station.lat, station.lon, w, h);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x - 6, y);
  ctx.lineTo(x + 6, y);
  ctx.moveTo(x, y - 6);
  ctx.lineTo(x, y + 6);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 3.5, 0, 2 * Math.PI);
  ctx.stroke();
}

export function WorldMap({ date, station }: WorldMapProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  // The observer is set up once. Keeping it out of the drawing effect
  // matters because that effect reruns on every tick of the clock, which
  // would otherwise tear down and rebuild a ResizeObserver once a second
  // for the lifetime of the window.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => setSize({ w: wrap.clientWidth, h: wrap.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  // getComputedStyle forces a style resolution, so the palette is read
  // once rather than 86,400 times a day. The theme is fixed at runtime —
  // <html> is hard-coded to `dark` — so there is nothing to react to.
  const colors = useMemo(() => ({
    ocean: readToken("--background", "#0b0f14"),
    land: readToken("--muted", "#1d2430"),
    grid: readToken("--grid", "#243040"),
    night: "oklch(0 0 0 / 45%)",
    station: readToken("--signal", "#4ade80"),
  }), []);

  // Rebuilt only when the map is resized. React is explicitly allowed to
  // discard a useMemo cache, but the only cost here is rebuilding a path
  // that is already rebuilt on resize — no correctness risk, unlike the
  // canvas ref in routes/index.tsx where a discarded memo would wipe a
  // pass mid-capture.
  const landPath = useMemo(
    () => (size.w > 0 && size.h > 0 ? buildLandPath(size.w, size.h) : null),
    [size.w, size.h],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const { w, h } = size;
    if (!canvas || !landPath || w === 0 || h === 0) return;

    const dpr = window.devicePixelRatio || 1;
    // Assigning width/height clears the canvas, which is exactly what is
    // wanted at the top of a full redraw.
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = colors.ocean;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = colors.land;
    ctx.fill(landPath);
    drawGraticule(ctx, w, h, colors.grid);
    drawNight(ctx, w, h, date, colors.night);
    if (station) drawStation(ctx, w, h, station, colors.station);
  }, [date, station, size, landPath, colors]);

  return (
    <div ref={wrapRef} className="size-full min-h-0">
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}
