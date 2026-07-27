import { assertEquals, assertRejects } from "@std/assert";

import { lookupCoordinates } from "./geoip.ts";

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    )) as unknown as typeof fetch;
}

Deno.test("lookupCoordinates reads latitude and longitude", async () => {
  const coords = await lookupCoordinates(
    jsonFetch({ success: true, latitude: 52.23, longitude: 21.01, city: "Warsaw" }),
  );
  assertEquals(coords, { lat: 52.23, lon: 21.01 });
});

Deno.test("lookupCoordinates rejects an unsuccessful lookup", async () => {
  await assertRejects(() =>
    lookupCoordinates(jsonFetch({ success: false, message: "rate limited" }))
  );
});

Deno.test("lookupCoordinates rejects an HTTP error", async () => {
  await assertRejects(() => lookupCoordinates(jsonFetch({}, 503)));
});

Deno.test("lookupCoordinates rejects out-of-range coordinates", async () => {
  await assertRejects(() =>
    lookupCoordinates(jsonFetch({ success: true, latitude: 999, longitude: 0 }))
  );
});

Deno.test("lookupCoordinates rejects a missing payload", async () => {
  await assertRejects(() => lookupCoordinates(jsonFetch({ success: true })));
});
