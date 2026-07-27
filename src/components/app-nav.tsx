import { Link } from "@tanstack/react-router";
import { Map, Radio, Satellite } from "lucide-react";

const TABS = [
  { to: "/", label: "Capture", icon: Radio },
  { to: "/tracking", label: "Tracking", icon: Map },
] as const;

export function AppNav() {
  return (
    <nav className="flex shrink-0 items-center gap-6 border-b border-border bg-sidebar px-4 py-2">
      <div className="flex items-center gap-2">
        <Satellite className="size-4 text-signal" />
        <span className="font-mono text-sm tracking-[0.2em] uppercase">satelita</span>
      </div>

      <div className="flex items-center gap-1">
        {TABS.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="flex items-center gap-2 rounded-md px-3 py-1.5 font-mono text-xs tracking-wider uppercase text-muted-foreground transition-colors hover:text-foreground data-[status=active]:bg-accent data-[status=active]:text-accent-foreground"
          >
            <Icon className="size-3.5" />
            {label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
