import { useRef } from "react";
import { Radio, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

export const SATS = [
  { id: "15", label: "NOAA-15", freq: "137.620 MHz" },
  { id: "18", label: "NOAA-18", freq: "137.9125 MHz" },
  { id: "19", label: "NOAA-19", freq: "137.100 MHz" },
];

/** Tuner gain range for the R820T/R820T2 front end rtl_fm drives. rtl_fm
 * snaps to the nearest supported step, so a continuous slider is fine. */
const GAIN_MIN = 0;
const GAIN_MAX = 49.6;

export interface CapturePanelProps {
  sat: string;
  onSatChange: (value: string) => void;
  gain: string;
  onGainChange: (value: string) => void;
  device: string;
  onDeviceChange: (value: string) => void;
  recording: boolean;
  onStart: () => void;
  onStop: () => void;
}

export function CapturePanel({
  sat,
  onSatChange,
  gain,
  onGainChange,
  device,
  onDeviceChange,
  recording,
  onStart,
  onStop,
}: CapturePanelProps) {
  const agc = gain === "agc";
  // Remembered so toggling AGC off restores the value you had dialled in.
  const lastManualGain = useRef("45");
  if (!agc) lastManualGain.current = gain;

  const numericGain = Number(agc ? lastManualGain.current : gain);
  const sliderValue = Number.isFinite(numericGain)
    ? Math.min(GAIN_MAX, Math.max(GAIN_MIN, numericGain))
    : 45;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sat" className="text-xs tracking-wide text-muted-foreground uppercase">
          Satellite
        </Label>
        <Select value={sat} onValueChange={(v) => v && onSatChange(v)} disabled={recording}>
          <SelectTrigger id="sat" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SATS.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                <span className="flex w-full items-center justify-between gap-3">
                  <span>{s.label}</span>
                  <span className="font-mono text-xs text-muted-foreground">{s.freq}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="gain" className="text-xs tracking-wide text-muted-foreground uppercase">
            Gain
          </Label>
          <button
            type="button"
            onClick={() => onGainChange(agc ? lastManualGain.current : "agc")}
            disabled={recording}
            className={cn(
              "rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-wide uppercase transition-colors",
              "disabled:cursor-not-allowed disabled:opacity-50",
              agc
                ? "border-signal/40 bg-signal/15 text-signal"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={agc}
          >
            AGC
          </button>
        </div>

        <div className="flex items-center gap-2">
          <Slider
            value={sliderValue}
            onValueChange={(v) => onGainChange(String(Array.isArray(v) ? v[0] : v))}
            min={GAIN_MIN}
            max={GAIN_MAX}
            step={0.1}
            disabled={recording || agc}
            aria-label="Gain in dB"
            className="flex-1"
          />
          <Input
            id="gain"
            value={agc ? "agc" : gain}
            onChange={(e) => onGainChange(e.target.value)}
            disabled={recording || agc}
            className="w-16 text-center font-mono tabular-nums"
            aria-label="Gain value"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="device" className="text-xs tracking-wide text-muted-foreground uppercase">
          Device
        </Label>
        <Input
          id="device"
          value={device}
          onChange={(e) => onDeviceChange(e.target.value)}
          disabled={recording}
          className="w-full font-mono tabular-nums"
        />
      </div>

      {!recording
        ? (
          <Button onClick={onStart} className="w-full gap-2">
            <Radio className="size-4" />
            Record
          </Button>
        )
        : (
          <Button variant="destructive" onClick={onStop} className="w-full gap-2">
            <Square className="size-4 fill-current" />
            Stop
          </Button>
        )}
    </div>
  );
}
