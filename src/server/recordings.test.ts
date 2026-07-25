/// <reference lib="deno.ns" />
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  deleteRecording,
  isFinalImage,
  isValidRecordingId,
  listRecordings,
  readFinalImage,
  recordingsRoot,
} from "./recordings.ts";

const ENV_KEYS = ["XDG_DATA_HOME", "HOME", "APPDATA"] as const;

async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const tmp = await Deno.makeTempDir();
  const saved = ENV_KEYS.map((k) => [k, Deno.env.get(k)] as const);
  for (const k of ENV_KEYS) Deno.env.set(k, tmp);
  try {
    const root = recordingsRoot();
    // Guard: never let a resolution surprise point the test at real data.
    assert(root.startsWith(tmp), `recordingsRoot() escaped the temp dir: ${root}`);
    await Deno.mkdir(root, { recursive: true });
    await fn(root);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    await Deno.remove(tmp, { recursive: true });
  }
}

/** Build a recording directory. `rawBytes` sets signal.raw's size, which
 * is what duration is derived from. */
async function makeRecording(
  root: string,
  id: string,
  opts: { rawBytes?: number; dataset?: unknown; images?: string[] } = {},
): Promise<void> {
  const dir = `${root}/${id}`;
  await Deno.mkdir(`${dir}/decode`, { recursive: true });
  await Deno.writeFile(`${dir}/signal.raw`, new Uint8Array(opts.rawBytes ?? 0));
  if (opts.dataset !== undefined) {
    await Deno.writeTextFile(`${dir}/decode/dataset.json`, JSON.stringify(opts.dataset));
  }
  for (const name of opts.images ?? []) {
    await Deno.writeFile(`${dir}/decode/${name}.png`, new Uint8Array(16));
  }
}

Deno.test("isValidRecordingId accepts run ids and rejects traversal", () => {
  assertEquals(isValidRecordingId("noaa15-1784827259"), true);
  assertEquals(isValidRecordingId("noaa19-1"), true);
  assertEquals(isValidRecordingId(".."), false);
  assertEquals(isValidRecordingId("../../etc"), false);
  assertEquals(isValidRecordingId("noaa15-1784827259/../.."), false);
  assertEquals(isValidRecordingId("/etc/passwd"), false);
  assertEquals(isValidRecordingId("noaa15"), false);
  assertEquals(isValidRecordingId(""), false);
});

Deno.test("isFinalImage allows only the three satdump outputs", () => {
  assertEquals(isFinalImage("raw_sync"), true);
  assertEquals(isFinalImage("APT-A"), true);
  assertEquals(isFinalImage("APT-B"), true);
  assertEquals(isFinalImage("raw_unsync"), false);
  assertEquals(isFinalImage("../../../etc/passwd"), false);
  assertEquals(isFinalImage("APT-A.png"), false);
});

Deno.test("listRecordings returns an empty list when nothing was ever recorded", async () => {
  await withTempRoot(async (root) => {
    await Deno.remove(root, { recursive: true });
    assertEquals(await listRecordings(), []);
  });
});

Deno.test("listRecordings prefers dataset.json and derives duration from raw size", async () => {
  await withTempRoot(async (root) => {
    // 110 s at 60 kHz s16 mono = 110 * 60000 * 2 bytes
    await makeRecording(root, "noaa15-1784827259", {
      rawBytes: 110 * 60_000 * 2,
      dataset: { satellite: "NOAA-15", timestamp: 1784827259.0 },
      images: ["raw_sync", "APT-A", "APT-B"],
    });

    const [rec] = await listRecordings();
    assertEquals(rec.id, "noaa15-1784827259");
    assertEquals(rec.satellite, "NOAA-15");
    assertEquals(rec.startedAt, 1784827259);
    assertEquals(rec.durationSecs, 110);
    assertEquals(rec.images, ["raw_sync", "APT-A", "APT-B"]);
    assertEquals(rec.complete, true);
    assert(rec.bytes > 110 * 60_000 * 2, "bytes should include decode/ contents");
  });
});

Deno.test("listRecordings falls back to the directory name and flags aborted runs", async () => {
  await withTempRoot(async (root) => {
    // Aborted run: empty decode/, no dataset.json, no images.
    await makeRecording(root, "noaa19-1784913812", { rawBytes: 60_000 * 2 * 13 });

    const [rec] = await listRecordings();
    assertEquals(rec.satellite, "NOAA-19");
    assertEquals(rec.startedAt, 1784913812);
    assertEquals(rec.durationSecs, 13);
    assertEquals(rec.images, []);
    assertEquals(rec.complete, false);
  });
});

Deno.test("listRecordings sorts newest first and skips foreign directories", async () => {
  await withTempRoot(async (root) => {
    await makeRecording(root, "noaa15-1000");
    await makeRecording(root, "noaa19-3000");
    await makeRecording(root, "noaa18-2000");
    await Deno.mkdir(`${root}/not-a-recording`, { recursive: true });

    const ids = (await listRecordings()).map((r) => r.id);
    assertEquals(ids, ["noaa19-3000", "noaa18-2000", "noaa15-1000"]);
  });
});

Deno.test("deleteRecording removes the directory", async () => {
  await withTempRoot(async (root) => {
    await makeRecording(root, "noaa15-1784827259", { images: ["raw_sync"] });
    await deleteRecording("noaa15-1784827259");
    assertEquals(await listRecordings(), []);
  });
});

Deno.test("deleteRecording refuses invalid ids before touching the filesystem", async () => {
  await withTempRoot(async (root) => {
    await makeRecording(root, "noaa15-1784827259");
    for (const bad of ["..", "../..", "noaa15-1784827259/../..", "/etc", ""]) {
      await assertRejects(() => deleteRecording(bad), Error, "Invalid recording id");
    }
    // The real recording is untouched.
    assertEquals((await listRecordings()).length, 1);
  });
});

Deno.test("readFinalImage returns bytes for allowed names and null otherwise", async () => {
  await withTempRoot(async (root) => {
    await makeRecording(root, "noaa15-1784827259", { images: ["APT-A"] });

    const ok = await readFinalImage("noaa15-1784827259", "APT-A");
    assertEquals(ok?.length, 16);

    assertEquals(await readFinalImage("noaa15-1784827259", "APT-B"), null);
    assertEquals(await readFinalImage("noaa15-1784827259", "raw_unsync"), null);
    assertEquals(await readFinalImage("..", "APT-A"), null);
    assertEquals(await readFinalImage("noaa15-1784827259", "../../../etc/passwd"), null);
  });
});
