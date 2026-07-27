import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/tracking")({
  component: Tracking,
});

function Tracking() {
  return (
    <main className="grid min-h-0 flex-1 grid-cols-[19rem_1fr] overflow-hidden">
      <aside className="flex min-h-0 flex-col gap-5 overflow-y-auto border-r border-border bg-sidebar p-4">
        <p className="font-mono text-xs text-muted-foreground">Station and passes</p>
      </aside>
      <section className="min-h-0 bg-background" />
    </main>
  );
}
