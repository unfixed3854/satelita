// Equirectangular projection: longitude maps linearly to x, latitude
// linearly to y. It distorts area badly near the poles, but it is the
// projection that makes a satellite's ground track read as the familiar
// sine wave, which is the whole point of the map.

export function project(
  lat: number,
  lon: number,
  width: number,
  height: number,
): { x: number; y: number } {
  return {
    x: ((lon + 180) / 360) * width,
    y: ((90 - lat) / 180) * height,
  };
}

/** Splits a path wherever consecutive points jump more than half the globe
 * in longitude — the signature of a wrap across the antimeridian.
 *
 * Without this, a track running from 179 to -179 draws as a line all the
 * way back across the map: one long horizontal streak through every
 * continent, which reads as a rendering bug rather than a wrap. */
export function splitAtAntimeridian<T extends { lon: number }>(points: T[]): T[][] {
  const segments: T[][] = [];
  let current: T[] = [];

  for (const point of points) {
    const previous = current.at(-1);
    if (previous && Math.abs(point.lon - previous.lon) > 180) {
      segments.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}
