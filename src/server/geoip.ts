// Approximate coordinates from the machine's public IP, used once to seed
// the ground station so a first run has something to predict passes
// against. City-accurate at best, and always editable afterwards.

const GEOIP_URL = "https://ipwho.is/";

interface IpWhoIsResponse {
  success?: boolean;
  message?: string;
  latitude?: number;
  longitude?: number;
}

export async function lookupCoordinates(
  fetchImpl: typeof fetch = fetch,
): Promise<{ lat: number; lon: number }> {
  const res = await fetchImpl(GEOIP_URL);
  if (!res.ok) throw new Error(`Geolocation lookup failed: HTTP ${res.status}`);

  const body = await res.json() as IpWhoIsResponse;
  // ipwho.is answers 200 with success:false for rate limits and reserved
  // addresses, so the status code alone does not mean a usable fix.
  if (body.success === false) {
    throw new Error(`Geolocation lookup failed: ${body.message ?? "unknown error"}`);
  }

  const { latitude: lat, longitude: lon } = body;
  if (
    typeof lat !== "number" || typeof lon !== "number" ||
    !Number.isFinite(lat) || !Number.isFinite(lon) ||
    lat < -90 || lat > 90 || lon < -180 || lon > 180
  ) {
    throw new Error("Geolocation lookup returned no usable coordinates");
  }
  return { lat, lon };
}
