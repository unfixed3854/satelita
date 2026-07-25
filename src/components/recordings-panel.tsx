import { useEffect, useRef, useState } from "react";
import { HardDrive, ImageOff, Trash2 } from "lucide-react";

import type { Recording } from "@/server/recordings";
import { fmtBytes, fmtClock, fmtElapsed } from "@/lib/apt";
import { cn } from "@/lib/utils";

export interface RecordingsPanelProps {
  recordings: Recording[];
  selectedId: string | null;
  /** Opening past passes is blocked while a recording is running, so
   * browsing history cannot clobber a live decode. */
  openDisabled: boolean;
  onOpen: (recording: Recording) => void;
  onDelete: (id: string) => void;
}

export function RecordingsPanel({
  recordings,
  selectedId,
  openDisabled,
  onOpen,
  onDelete,
}: RecordingsPanelProps) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const totalBytes = recordings.reduce((sum, r) => sum + r.bytes, 0);

  // Focus management for the two-step delete confirm. The trash button and
  // the Delete/Cancel span are mutually-exclusive subtrees, so React
  // unmounts one and mounts the other on every transition — without this,
  // the browser drops focus to <body> and a keyboard/screen-reader user
  // loses their place in the list on the one workflow that destroys data.
  const trashRefs = useRef(new Map<string, HTMLButtonElement>());
  const cancelRefs = useRef(new Map<string, HTMLButtonElement>());
  // What caused the most recent confirmingId change, set synchronously by
  // the handler below and consumed by the effect once React has committed
  // the resulting DOM. "delete" is intentionally not restored to — that
  // row is about to disappear from the recordings list.
  const lastActionRef = useRef<{ type: "open" | "cancel"; id: string } | { type: "delete" } | null>(
    null,
  );

  useEffect(() => {
    const action = lastActionRef.current;
    if (!action) return;
    if (action.type === "open") {
      // Land on Cancel, not Delete — Cancel is the safe default, and
      // landing focus on a destructive control invites an accidental
      // second Enter press.
      cancelRefs.current.get(action.id)?.focus();
    } else if (action.type === "cancel") {
      trashRefs.current.get(action.id)?.focus();
    }
  }, [confirmingId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-xs tracking-wide text-muted-foreground uppercase">Recordings</span>
        <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground tabular-nums">
          <HardDrive className="size-3" />
          {fmtBytes(totalBytes)}
        </span>
      </div>

      {recordings.length === 0
        ? <p className="text-xs text-muted-foreground">No recordings yet.</p>
        : (
          <ul className="-mr-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1">
            {recordings.map((r) => {
              const confirming = confirmingId === r.id;
              const canOpen = r.complete && !openDisabled;
              return (
                <li
                  key={r.id}
                  className={cn(
                    "group rounded-md border px-2 py-1.5 transition-colors",
                    selectedId === r.id
                      ? "border-signal/40 bg-signal/10"
                      : "border-transparent hover:border-border hover:bg-card",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => canOpen && onOpen(r)}
                      disabled={!canOpen}
                      title={r.complete
                        ? openDisabled ? "Stop the current pass to open this" : "Open this pass"
                        : "No image — this run was aborted before decoding"}
                      className={cn(
                        "flex min-w-0 flex-1 flex-col items-start text-left",
                        !canOpen && "cursor-not-allowed",
                        !r.complete && "opacity-50",
                      )}
                    >
                      <span className="flex w-full items-center gap-1.5 text-xs font-medium">
                        {!r.complete && <ImageOff className="size-3 shrink-0" />}
                        <span className="truncate">{r.satellite}</span>
                        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                          {fmtElapsed(r.durationSecs)}
                        </span>
                      </span>
                      <span className="flex w-full items-baseline gap-2 font-mono text-[10px] text-muted-foreground tabular-nums">
                        <span className="truncate">{fmtClock(r.startedAt)}</span>
                        <span className="ml-auto shrink-0">{fmtBytes(r.bytes)}</span>
                      </span>
                    </button>

                    {confirming
                      ? (
                        <span className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              lastActionRef.current = { type: "delete" };
                              onDelete(r.id);
                              setConfirmingId(null);
                            }}
                            aria-label={`Delete recording from ${fmtClock(r.startedAt)}`}
                            className="rounded bg-destructive px-1.5 py-0.5 text-[10px] font-medium text-white"
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            ref={(el) => {
                              if (el) cancelRefs.current.set(r.id, el);
                              else cancelRefs.current.delete(r.id);
                            }}
                            onClick={() => {
                              lastActionRef.current = { type: "cancel", id: r.id };
                              setConfirmingId(null);
                            }}
                            aria-label={`Cancel deleting recording from ${fmtClock(r.startedAt)}`}
                            className="rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                          >
                            Cancel
                          </button>
                        </span>
                      )
                      : (
                        <button
                          type="button"
                          ref={(el) => {
                            if (el) trashRefs.current.set(r.id, el);
                            else trashRefs.current.delete(r.id);
                          }}
                          onClick={() => {
                            lastActionRef.current = { type: "open", id: r.id };
                            setConfirmingId(r.id);
                          }}
                          title={`Delete this recording (${fmtBytes(r.bytes)})`}
                          aria-label={`Delete recording from ${fmtClock(r.startedAt)}`}
                          className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
    </div>
  );
}
