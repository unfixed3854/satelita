import type { RecorderPhase } from "@/hooks/use-recorder-events";
import { fmtElapsed } from "@/lib/apt";
import { cn } from "@/lib/utils";

const PHASE_LABEL: Record<RecorderPhase, string> = {
  idle: "IDLE",
  recording: "RECORDING",
  decoding: "DECODING",
  stopped: "STOPPED",
};

export interface StatusHeaderProps {
  phase: RecorderPhase;
  satellite: string;
  freq: string;
  elapsed: number;
}

export function StatusHeader({ phase, satellite, freq, elapsed }: StatusHeaderProps) {
  return (
    <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
      <span className="text-sm font-medium">{satellite}</span>
      <span className="font-mono text-xs text-muted-foreground tabular-nums">{freq}</span>

      <div className="ml-auto flex items-center gap-3">
        {phase === "recording" && (
          <span className="size-2 animate-pulse rounded-full bg-destructive" aria-hidden />
        )}
        <span
          className={cn(
            "rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-wider",
            phase === "recording" && "border-destructive/40 bg-destructive/15 text-destructive",
            phase === "decoding" && "border-signal/40 bg-signal/15 text-signal",
            (phase === "idle" || phase === "stopped") && "border-border text-muted-foreground",
          )}
        >
          {PHASE_LABEL[phase]}
        </span>
        {(phase === "recording" || phase === "decoding") && (
          <span className="font-mono text-sm font-medium tabular-nums">{fmtElapsed(elapsed)}</span>
        )}
      </div>
    </header>
  );
}
