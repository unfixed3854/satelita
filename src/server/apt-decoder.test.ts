/// <reference lib="deno.ns" />
import { assert } from "@std/assert";
import { AptDecoder, APT_LINE_WIDTH } from "./apt-decoder.ts";

const PIXELS_PER_SEC = 4160;
const SUBCARRIER_HZ = 2400;

function testImage(width: number, height: number): Uint8Array[] {
  const img: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(width);
    for (let x = 0; x < width; x++) {
      let v: number;
      if (x < 28) {
        v = Math.floor(x / 2) % 2 === 0 ? 255 : 0; // sync A
      } else if (x < 60) {
        v = 0; // space
      } else {
        const bars = Math.floor(x / 64) % 2 === 0 ? 200 : 60;
        const block = x > 900 && x < 1200 && y > 8 && y < 24 ? 255 : bars;
        const grad = Math.floor((y * 255) / height);
        v = Math.min(255, Math.max(0, Math.trunc((block + grad) / 2)));
      }
      row[x] = v;
    }
    img.push(row);
  }
  return img;
}

function synthAudio(img: Uint8Array[], width: number, fs: number): Float32Array {
  const spp = fs / PIXELS_PER_SEC;
  const totalPixels = width * img.length;
  const totalSamples = Math.floor(totalPixels * spp);
  const audio = new Float32Array(totalSamples);
  for (let n = 0; n < totalSamples; n++) {
    const pixelIdx = Math.floor(n / spp);
    const px = pixelIdx % width;
    const py = Math.min(Math.floor(pixelIdx / width), img.length - 1);
    const v = img[py][px] / 255;
    const amp = 0.1 + 0.9 * v;
    const carrier = Math.sin((2 * Math.PI * SUBCARRIER_HZ * n) / fs);
    audio[n] = amp * carrier;
  }
  return audio;
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return num / Math.max(Math.sqrt(da) * Math.sqrt(db), 1e-9);
}

Deno.test("reconstructs synthetic APT image", () => {
  const fs = 60_000;
  const width = APT_LINE_WIDTH;
  const height = 40;
  const img = testImage(width, height);
  const audio = synthAudio(img, width, fs);

  const dec = new AptDecoder(fs);
  const lines: Uint8Array[] = [];
  const chunkSize = 8192;
  for (let i = 0; i < audio.length; i += chunkSize) {
    const chunk = audio.subarray(i, Math.min(i + chunkSize, audio.length));
    lines.push(...dec.process(chunk));
  }

  assert(lines.length >= height - 3, `expected ~${height} lines, got ${lines.length}`);

  const li = Math.floor(lines.length / 2);
  const decLine = lines[li].slice(100, 2000);
  let best = -1;
  for (let iy = 0; iy < height; iy++) {
    const inLine = img[iy].slice(100, 2000);
    best = Math.max(best, pearson(decLine, inLine));
  }

  console.log(`decoded ${lines.length} lines, best line correlation = ${best.toFixed(3)}`);
  assert(best > 0.85, `decoded image correlation too low: ${best.toFixed(3)}`);
});

function noiseAudio(length: number): Float32Array {
  const out = new Float32Array(length);
  let seed = 12345;
  for (let i = 0; i < length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (seed / 0x7fffffff) * 2 - 1;
  }
  return out;
}

function runDecoder(audio: Float32Array, fs: number): AptDecoder {
  const dec = new AptDecoder(fs);
  const chunkSize = 8192;
  for (let i = 0; i < audio.length; i += chunkSize) {
    dec.process(audio.subarray(i, Math.min(i + chunkSize, audio.length)));
  }
  return dec;
}

Deno.test("sync lock separates APT from noise", () => {
  const fs = 60_000;
  const img = testImage(APT_LINE_WIDTH, 40);
  const aptAudio = synthAudio(img, APT_LINE_WIDTH, fs);

  const apt = runDecoder(aptAudio, fs);
  const noise = runDecoder(noiseAudio(aptAudio.length), fs);

  // Printed so the two normalization constants can be calibrated from
  // measurement rather than from theory.
  console.log(
    `sync raw: apt=${apt.lastSyncRaw.toFixed(3)} noise=${noise.lastSyncRaw.toFixed(3)}`,
  );
  console.log(
    `sync score: apt=${apt.lastSyncScore.toFixed(3)} noise=${noise.lastSyncScore.toFixed(3)}`,
  );

  assert(apt.lastSyncScore > 0.5, `APT sync score too low: ${apt.lastSyncScore}`);
  assert(noise.lastSyncScore < 0.2, `noise sync score too high: ${noise.lastSyncScore}`);
});

Deno.test("sync score behaves as a graduated meter under partial noise", () => {
  const fs = 60_000;
  const img = testImage(APT_LINE_WIDTH, 40);
  const aptAudio = synthAudio(img, APT_LINE_WIDTH, fs);
  const noise = noiseAudio(aptAudio.length);

  // Additive white noise mixed into clean synthetic APT at increasing
  // relative amplitudes. The LCG that produces `noise` is fixed-seed, so
  // this sweep is deterministic across runs.
  const noiseAmps = [0, 0.25, 0.5, 1.0, 2.0];
  const results = noiseAmps.map((amp) => {
    const mixed = new Float32Array(aptAudio.length);
    for (let i = 0; i < mixed.length; i++) {
      mixed[i] = aptAudio[i] + amp * noise[i];
    }
    const dec = runDecoder(mixed, fs);
    return { amp, raw: dec.lastSyncRaw, score: dec.lastSyncScore };
  });

  console.log("noise amp -> sync raw -> sync score");
  for (const r of results) {
    console.log(`  ${r.amp.toFixed(2)} -> raw=${r.raw.toFixed(3)} score=${r.score.toFixed(3)}`);
  }

  // 1. lastSyncRaw should decrease (or hold, within tolerance) as noise
  // grows. The tolerance is wider than plain EMA jitter would need: once
  // noise fully swamps the signal (amp >= 1.0 here), "raw" stops trending
  // down and instead fluctuates around the empirical noise floor, because
  // it is the max over 65 offsets — an order statistic that converges to a
  // floor rather than continuing toward -Infinity as the true signal
  // vanishes further. That is a property of the metric, not a bug; both
  // ends of that particular jump are already saturated at score 0.000, so
  // it doesn't affect the UI, but it's real and worth tolerance for.
  const tolerance = 0.1;
  for (let i = 1; i < results.length; i++) {
    const prev = results[i - 1];
    const cur = results[i];
    assert(
      cur.raw <= prev.raw + tolerance,
      `sync raw not monotonically decreasing: amp=${prev.amp} raw=${prev.raw.toFixed(3)} -> ` +
        `amp=${cur.amp} raw=${cur.raw.toFixed(3)}`,
    );
  }

  // 2. At least one intermediate SNR should land strictly inside the rails,
  // i.e. the meter reads a genuine middle value rather than snapping
  // between 0 and 1.
  const midRange = results.filter((r) => r.score > 0.05 && r.score < 0.95);
  assert(
    midRange.length > 0,
    `no intermediate noise amplitude produced a mid-range score; all scores ` +
      `saturated at the rails: ${JSON.stringify(results)}`,
  );
});
