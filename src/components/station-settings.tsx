import { useEffect, useState } from "react";
import { Crosshair } from "lucide-react";

import type { Station } from "@/server/station";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface StationSettingsProps {
  station: Station | null;
  detecting: boolean;
  saving: boolean;
  error: string | null;
  onSave: (values: { lat: number; lon: number; altM: number }) => void;
  onDetect: () => void;
}

function parseCoordinate(value: string, limit: number): number | null {
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n)) return null;
  return n >= -limit && n <= limit ? n : null;
}

export function StationSettings(
  { station, detecting, saving, error, onSave, onDetect }: StationSettingsProps,
) {
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [altM, setAltM] = useState("");

  // Re-seed the fields whenever a new station arrives — on first load, and
  // after Detect replaces the coordinates the operator is looking at.
  useEffect(() => {
    setLat(station ? String(station.lat) : "");
    setLon(station ? String(station.lon) : "");
    setAltM(station ? String(station.altM) : "");
  }, [station]);

  const parsedLat = parseCoordinate(lat, 90);
  const parsedLon = parseCoordinate(lon, 180);
  const parsedAlt = Number(altM.trim() === "" ? "0" : altM);

  // A single nullable payload rather than a parallel `valid` boolean:
  // TypeScript cannot carry the knowledge that `valid === true` implies
  // the two coordinates are non-null into the click handler's closure, so
  // the narrowing has to live in the value itself.
  const values = parsedLat !== null && parsedLon !== null && Number.isFinite(parsedAlt)
    ? { lat: parsedLat, lon: parsedLon, altM: parsedAlt }
    : null;

  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-center justify-between">
        <h2 className="font-mono text-xs tracking-[0.2em] uppercase text-muted-foreground">
          Station
        </h2>
        {station && (
          <span className="font-mono text-[10px] uppercase text-muted-foreground">
            {station.source === "auto" ? "auto-detected" : "manual"}
          </span>
        )}
      </header>

      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="station-lat" className="font-mono text-[11px]">Latitude</Label>
          <Input
            id="station-lat"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            inputMode="decimal"
            aria-invalid={lat !== "" && parsedLat === null}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="station-lon" className="font-mono text-[11px]">Longitude</Label>
          <Input
            id="station-lon"
            value={lon}
            onChange={(e) => setLon(e.target.value)}
            inputMode="decimal"
            aria-invalid={lon !== "" && parsedLon === null}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="station-alt" className="font-mono text-[11px]">Altitude (m)</Label>
        <Input
          id="station-alt"
          value={altM}
          onChange={(e) => setAltM(e.target.value)}
          inputMode="decimal"
        />
      </div>

      {error && <p className="font-mono text-[11px] text-destructive">{error}</p>}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={values === null || saving}
          onClick={() => values && onSave(values)}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="secondary" disabled={detecting} onClick={onDetect}>
          <Crosshair className="size-3.5" />
          {detecting ? "Detecting…" : "Detect"}
        </Button>
      </div>
    </section>
  );
}
