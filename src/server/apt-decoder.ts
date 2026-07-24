// Minimal real-time NOAA APT decoder — ported from src-tauri/src/apt.rs
// (removed). Consumes a stream of FM-demodulated audio samples and
// produces 8-bit grayscale image lines, emitting each line as soon as its
// pixels exist (~2 lines/second — the physical APT rate).
//
// Signal path per sample:
//   1. mix the 2400 Hz AM subcarrier down to baseband (complex),
//   2. 2-pole low-pass I/Q to recover the envelope = pixel brightness,
//   3. box-average resample to the 4160 px/s pixel rate,
//   4. adaptive (EMA mean/std) normalization to 0..255,
//   5. sync-align pixels into 2080-wide lines via sync-A correlation.

export const APT_LINE_WIDTH = 2080;
const PIXELS_PER_SEC = 4160;
const SUBCARRIER_HZ = 2400;
const SYNC_SEARCH = 64;
const SYNC_TPL = 28;
const TAU = Math.PI * 2;

export class AptDecoder {
  private phase = 0;
  private readonly phaseInc: number;
  private readonly lpfAlpha: number;
  private i1 = 0;
  private i2 = 0;
  private q1 = 0;
  private q2 = 0;

  private readonly samplesPerPixel: number;
  private pixPhase = 0;
  private pixSum = 0;
  private pixCnt = 0;

  private mean = 0;
  private variance = 0.01;
  private readonly normAlpha = 2e-4;
  private seeded = false;

  private pixbuf: number[] = [];
  linesOut = 0;

  constructor(sampleRate: number) {
    this.phaseInc = (TAU * SUBCARRIER_HZ) / sampleRate;
    this.lpfAlpha = 1 - Math.exp((-2 * Math.PI * SUBCARRIER_HZ) / sampleRate);
    this.samplesPerPixel = sampleRate / PIXELS_PER_SEC;
  }

  /** Feed audio samples (roughly [-1, 1]); returns any completed 8-bit
   * grayscale lines (each APT_LINE_WIDTH bytes). */
  process(samples: Float32Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (const x of samples) {
      // 1. mix 2400 Hz subcarrier to baseband
      const s = Math.sin(this.phase);
      const c = Math.cos(this.phase);
      this.phase += this.phaseInc;
      if (this.phase > TAU) this.phase -= TAU;
      const i = x * c;
      const q = -x * s;

      // 2. 2-pole low-pass on I/Q, then magnitude = envelope
      this.i1 += this.lpfAlpha * (i - this.i1);
      this.i2 += this.lpfAlpha * (this.i1 - this.i2);
      this.q1 += this.lpfAlpha * (q - this.q1);
      this.q2 += this.lpfAlpha * (this.q1 - this.q2);
      const env = Math.sqrt(this.i2 * this.i2 + this.q2 * this.q2);

      // 3. box-average resample to pixel rate
      this.pixSum += env;
      this.pixCnt += 1;
      this.pixPhase += 1;
      if (this.pixPhase >= this.samplesPerPixel) {
        this.pixPhase -= this.samplesPerPixel;
        const pv = this.pixSum / Math.max(this.pixCnt, 1);
        this.pixSum = 0;
        this.pixCnt = 0;
        this.pushPixel(pv, out);
      }
    }
    return out;
  }

  private pushPixel(v: number, out: Uint8Array[]): void {
    // 4. adaptive normalization stats
    if (!this.seeded) {
      this.mean = v;
      this.seeded = true;
    } else {
      const d = v - this.mean;
      this.mean += this.normAlpha * d;
      this.variance += this.normAlpha * (d * d - this.variance);
    }

    this.pixbuf.push(v);

    // 5. emit sync-aligned lines while we have enough pixels buffered
    while (this.pixbuf.length >= APT_LINE_WIDTH + SYNC_SEARCH) {
      const start = this.findLineStart();
      const line = new Uint8Array(APT_LINE_WIDTH);
      for (let k = 0; k < APT_LINE_WIDTH; k++) {
        line[k] = this.toU8(this.pixbuf[start + k]);
      }
      out.push(line);
      this.linesOut++;
      this.pixbuf.splice(0, start + APT_LINE_WIDTH);
    }
  }

  private toU8(v: number): number {
    const std = Math.sqrt(Math.max(this.variance, 1e-9));
    const lo = this.mean - 1.6 * std;
    const hi = this.mean + 1.6 * std;
    const t = ((v - lo) / Math.max(hi - lo, 1e-9)) * 255;
    const clamped = Math.min(255, Math.max(0, t));
    return Math.trunc(clamped);
  }

  /** Search a small window for the sync-A pulse train and return the offset
   * that best aligns the next line. Falls back to offset 0 (fixed stride)
   * when no clear sync is present (e.g. noise). */
  private findLineStart(): number {
    let best = 0;
    let bestScore = -Infinity;
    for (let o = 0; o <= SYNC_SEARCH; o++) {
      let score = 0;
      for (let k = 0; k < SYNC_TPL; k++) {
        // 2 px high, 2 px low, repeating -> +/- template
        const t = Math.floor(k / 2) % 2 === 0 ? 1 : -1;
        score += t * (this.pixbuf[o + k] - this.mean);
      }
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }
    return best;
  }
}
