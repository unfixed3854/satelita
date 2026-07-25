import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";

import { APT_LINE_WIDTH, CHANNEL_FRACTIONS, type ChannelMode } from "@/lib/apt";
import { cn } from "@/lib/utils";

export type StageSource =
  | { kind: "live" }
  | { kind: "recording"; id: string; images: string[] };

type ZoomMode = "fit-width" | "actual";

const ZOOMS: { id: ZoomMode; label: string }[] = [
  { id: "fit-width", label: "Fit width" },
  { id: "actual", label: "1:1" },
];

const CHANNELS: { id: ChannelMode; label: string }[] = [
  { id: "both", label: "A+B" },
  { id: "a", label: "A" },
  { id: "b", label: "B" },
];

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
          className={cn(
            "rounded border px-2 py-0.5 text-[11px] transition-colors",
            value === o.id
              ? "border-signal/40 bg-signal/15 text-signal"
              : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export interface ImageStageProps {
  source: StageSource;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  lines: number;
  recording: boolean;
  error: string | null;
  onDismissError: () => void;
}

export function ImageStage({
  source,
  canvasRef,
  wrapRef,
  lines,
  recording,
  error,
  onDismissError,
}: ImageStageProps) {
  const [zoom, setZoom] = useState<ZoomMode>("fit-width");
  const [channel, setChannel] = useState<ChannelMode>("both");
  // Known up front for the canvas; read from the load event for an image.
  const [naturalWidth, setNaturalWidth] = useState(APT_LINE_WIDTH);

  const live = source.kind === "live";

  // For a finished pass, prefer satdump's dedicated per-channel PNGs —
  // they are the calibrated 909 px video regions with sync, space, and
  // telemetry already stripped. Fall back to cropping raw_sync when a
  // channel file is missing.
  const channelFile = channel === "a" ? "APT-A" : channel === "b" ? "APT-B" : null;
  const useServerChannel = !live && channelFile !== null && source.images.includes(channelFile);
  const imageSrc = live
    ? null
    : `/api/recordings/${source.id}/${useServerChannel ? channelFile : "raw_sync"}`;

  // Crop only when the source is a full-width composite.
  const crop = live || !useServerChannel ? CHANNEL_FRACTIONS[channel] : CHANNEL_FRACTIONS.both;

  // Reset the view whenever the stage switches to a different source.
  const sourceKey = live ? "live" : source.id;
  useEffect(() => {
    setZoom("fit-width");
    setChannel("both");
    setNaturalWidth(APT_LINE_WIDTH);
  }, [sourceKey]);

  async function save() {
    const name = live ? "apt-live.png" : `${source.id}-${useServerChannel ? channelFile : "raw_sync"}.png`;
    let href: string;
    let revoke = false;

    if (live) {
      const canvas = canvasRef.current;
      if (!canvas || canvas.height === 0) return;
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
      if (!blob) return;
      href = URL.createObjectURL(blob);
      revoke = true;
    } else {
      href = imageSrc!;
    }

    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    a.click();
    if (revoke) URL.revokeObjectURL(href);
  }

  const fit = zoom === "fit-width";
  // See the table in this task's header: the viewport clips, the media
  // overflows it, and the negative margin selects which channel shows.
  const viewportStyle: React.CSSProperties = {
    overflow: "hidden",
    width: fit ? "100%" : `${naturalWidth * crop.width}px`,
  };
  const mediaStyle: React.CSSProperties = {
    imageRendering: "pixelated",
    display: "block",
    width: fit ? `${100 / crop.width}%` : `${naturalWidth}px`,
    maxWidth: "none",
    marginLeft: fit
      ? `-${(crop.start / crop.width) * 100}%`
      : `-${naturalWidth * crop.start}px`,
  };

  const empty = live && lines === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive"
        >
          <span className="flex-1">{error}</span>
          <button type="button" onClick={onDismissError} aria-label="Dismiss error">
            <X className="size-4" />
          </button>
        </div>
      )}

      <div ref={wrapRef} className="relative flex min-h-0 flex-1 justify-center overflow-auto p-4">
        {/* The canvas stays mounted whenever the source is live, even with
            nothing decoded yet — the route captures its 2D context on
            mount, and an unmounted canvas would silently drop the first
            lines of a pass. The empty state overlays it instead of
            replacing it. */}
        <div className="self-start bg-black" style={viewportStyle}>
          {live
            ? <canvas ref={canvasRef} aria-label="Live APT decode" style={mediaStyle} />
            : (
              <img
                src={imageSrc!}
                alt="Decoded APT image"
                style={mediaStyle}
                onLoad={(e) => setNaturalWidth(e.currentTarget.naturalWidth)}
              />
            )}
        </div>

        {empty && (
          <p className="pointer-events-none absolute top-24 left-1/2 max-w-[420px] -translate-x-1/2 text-center text-sm text-muted-foreground">
            {recording
              ? "Waiting for the first decoded lines — the image builds top-to-bottom in real time."
              : "No image yet. Start a recording when the satellite is above the horizon."}
          </p>
        )}
      </div>

      <div className="flex items-center gap-4 border-t border-border px-4 py-2">
        <SegmentedControl options={ZOOMS} value={zoom} onChange={setZoom} label="Zoom" />
        <SegmentedControl options={CHANNELS} value={channel} onChange={setChannel} label="Channel" />
        <button
          type="button"
          onClick={save}
          disabled={empty}
          className="ml-auto flex items-center gap-1.5 rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Download className="size-3.5" />
          Save
        </button>
      </div>
    </div>
  );
}
