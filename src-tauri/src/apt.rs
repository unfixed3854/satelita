//! Minimal real-time NOAA APT decoder.
//!
//! Consumes a stream of FM-demodulated audio samples and produces 8-bit
//! grayscale image lines, emitting each line as soon as its pixels exist
//! (~2 lines/second — the physical APT rate). This is deliberately a *live*
//! decoder: it trades satdump's calibration/quality for latency. satdump still
//! produces the polished final image when the pass ends.
//!
//! Signal path per sample:
//!   1. mix the 2400 Hz AM subcarrier down to baseband (complex),
//!   2. 2-pole low-pass I/Q to recover the envelope = pixel brightness,
//!   3. box-average resample to the 4160 px/s pixel rate,
//!   4. adaptive (EMA mean/std) normalization to 0..255,
//!   5. sync-align pixels into 2080-wide lines via sync-A correlation.

use std::f32::consts::{PI, TAU};

/// Full APT line width (both channels + sync + telemetry), in pixels.
pub const APT_LINE_WIDTH: usize = 2080;
/// APT pixel (word) rate.
const PIXELS_PER_SEC: f32 = 4160.0;
/// Subcarrier frequency the brightness is AM-modulated onto.
const SUBCARRIER_HZ: f32 = 2400.0;
/// How far to search for the sync-A pulse train when aligning each line.
const SYNC_SEARCH: usize = 64;
/// Sync-A correlation template length (7 cycles of 1040 Hz ≈ 4 px/cycle).
const SYNC_TPL: usize = 28;

pub struct AptDecoder {
    // subcarrier mixing
    phase: f32,
    phase_inc: f32,
    // envelope low-pass (2-pole, applied to I and Q)
    lpf_alpha: f32,
    i1: f32,
    i2: f32,
    q1: f32,
    q2: f32,
    // resample to pixel rate (box average)
    samples_per_pixel: f32,
    pix_phase: f32,
    pix_sum: f32,
    pix_cnt: f32,
    // adaptive normalization
    mean: f32,
    var: f32,
    norm_alpha: f32,
    seeded: bool,
    // line assembly
    pixbuf: Vec<f32>,
    pub lines_out: usize,
}

impl AptDecoder {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            phase: 0.0,
            phase_inc: TAU * SUBCARRIER_HZ / sample_rate,
            lpf_alpha: 1.0 - (-2.0 * PI * SUBCARRIER_HZ / sample_rate).exp(),
            i1: 0.0,
            i2: 0.0,
            q1: 0.0,
            q2: 0.0,
            samples_per_pixel: sample_rate / PIXELS_PER_SEC,
            pix_phase: 0.0,
            pix_sum: 0.0,
            pix_cnt: 0.0,
            mean: 0.0,
            var: 0.01,
            norm_alpha: 2e-4,
            seeded: false,
            pixbuf: Vec::with_capacity(APT_LINE_WIDTH * 3),
            lines_out: 0,
        }
    }

    /// Feed audio samples (roughly [-1, 1]); returns any completed 8-bit
    /// grayscale lines (each `APT_LINE_WIDTH` bytes).
    pub fn process(&mut self, samples: &[f32]) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        for &x in samples {
            // 1. mix 2400 Hz subcarrier to baseband
            let (s, c) = self.phase.sin_cos();
            self.phase += self.phase_inc;
            if self.phase > TAU {
                self.phase -= TAU;
            }
            let i = x * c;
            let q = -x * s;

            // 2. 2-pole low-pass on I/Q, then magnitude = envelope
            self.i1 += self.lpf_alpha * (i - self.i1);
            self.i2 += self.lpf_alpha * (self.i1 - self.i2);
            self.q1 += self.lpf_alpha * (q - self.q1);
            self.q2 += self.lpf_alpha * (self.q1 - self.q2);
            let env = (self.i2 * self.i2 + self.q2 * self.q2).sqrt();

            // 3. box-average resample to pixel rate
            self.pix_sum += env;
            self.pix_cnt += 1.0;
            self.pix_phase += 1.0;
            if self.pix_phase >= self.samples_per_pixel {
                self.pix_phase -= self.samples_per_pixel;
                let pv = self.pix_sum / self.pix_cnt.max(1.0);
                self.pix_sum = 0.0;
                self.pix_cnt = 0.0;
                self.push_pixel(pv, &mut out);
            }
        }
        out
    }

    fn push_pixel(&mut self, v: f32, out: &mut Vec<Vec<u8>>) {
        // 4. adaptive normalization stats
        if !self.seeded {
            self.mean = v;
            self.seeded = true;
        } else {
            let d = v - self.mean;
            self.mean += self.norm_alpha * d;
            self.var += self.norm_alpha * (d * d - self.var);
        }

        self.pixbuf.push(v);

        // 5. emit sync-aligned lines while we have enough pixels buffered
        while self.pixbuf.len() >= APT_LINE_WIDTH + SYNC_SEARCH {
            let start = self.find_line_start();
            let line: Vec<u8> = (0..APT_LINE_WIDTH)
                .map(|k| self.to_u8(self.pixbuf[start + k]))
                .collect();
            out.push(line);
            self.lines_out += 1;
            self.pixbuf.drain(0..start + APT_LINE_WIDTH);
        }
    }

    fn to_u8(&self, v: f32) -> u8 {
        let std = self.var.max(1e-9).sqrt();
        let lo = self.mean - 1.6 * std;
        let hi = self.mean + 1.6 * std;
        let t = ((v - lo) / (hi - lo).max(1e-9)) * 255.0;
        t.clamp(0.0, 255.0) as u8
    }

    /// Search a small window for the sync-A pulse train and return the offset
    /// that best aligns the next line. Falls back to offset 0 (fixed stride)
    /// when no clear sync is present (e.g. noise).
    fn find_line_start(&self) -> usize {
        let mut best = 0usize;
        let mut best_score = f32::MIN;
        for o in 0..=SYNC_SEARCH {
            let mut score = 0.0f32;
            for k in 0..SYNC_TPL {
                // 2 px high, 2 px low, repeating → +/- template
                let t = if (k / 2) % 2 == 0 { 1.0 } else { -1.0 };
                score += t * (self.pixbuf[o + k] - self.mean);
            }
            if score > best_score {
                best_score = score;
                best = o;
            }
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    /// Build a test image: sync-A pulse train + vertical bars + a bright block,
    /// with a slow vertical gradient so reconstruction is easy to eyeball.
    fn test_image(width: usize, height: usize) -> Vec<Vec<u8>> {
        let mut img = vec![vec![0u8; width]; height];
        for y in 0..height {
            for x in 0..width {
                let v = if x < 28 {
                    // sync A: 2 high, 2 low, repeated (matches decoder template)
                    if (x / 2) % 2 == 0 { 255 } else { 0 }
                } else if x < 60 {
                    0 // space
                } else {
                    let bars = if (x / 64) % 2 == 0 { 200 } else { 60 };
                    let block = if x > 900 && x < 1200 && y > 8 && y < 24 { 255 } else { bars };
                    let grad = (y * 255 / height) as i32;
                    ((block as i32 + grad) / 2).clamp(0, 255) as u8
                };
                img[y][x] = v;
            }
        }
        img
    }

    /// AM-modulate the image onto a 2400 Hz subcarrier at `fs`.
    fn synth_audio(img: &[Vec<u8>], width: usize, fs: f64) -> Vec<f32> {
        let spp = fs / PIXELS_PER_SEC as f64;
        let total_pixels = width * img.len();
        let total_samples = (total_pixels as f64 * spp) as usize;
        let mut audio = Vec::with_capacity(total_samples);
        for n in 0..total_samples {
            let pixel_idx = (n as f64 / spp) as usize;
            let px = pixel_idx % width;
            let py = (pixel_idx / width).min(img.len() - 1);
            let v = img[py][px] as f64 / 255.0;
            let amp = 0.1 + 0.9 * v;
            let carrier = (2.0 * PI * SUBCARRIER_HZ as f64 * n as f64 / fs).sin();
            audio.push((amp * carrier) as f32);
        }
        audio
    }

    fn pearson(a: &[f32], b: &[f32]) -> f32 {
        let n = a.len() as f32;
        let ma = a.iter().sum::<f32>() / n;
        let mb = b.iter().sum::<f32>() / n;
        let mut num = 0.0;
        let mut da = 0.0;
        let mut db = 0.0;
        for i in 0..a.len() {
            let x = a[i] - ma;
            let y = b[i] - mb;
            num += x * y;
            da += x * x;
            db += y * y;
        }
        num / (da.sqrt() * db.sqrt()).max(1e-9)
    }

    fn write_pgm(path: &str, img: &[Vec<u8>], width: usize) {
        let mut buf = format!("P5\n{} {}\n255\n", width, img.len()).into_bytes();
        for row in img {
            buf.extend_from_slice(row);
        }
        std::fs::write(path, buf).unwrap();
    }

    #[test]
    fn reconstructs_synthetic_apt() {
        let fs = 60_000.0f64;
        let width = APT_LINE_WIDTH;
        let height = 40;
        let img = test_image(width, height);
        let audio = synth_audio(&img, width, fs);

        let mut dec = AptDecoder::new(fs as f32);
        // feed in realistic-sized chunks
        let mut lines: Vec<Vec<u8>> = Vec::new();
        for chunk in audio.chunks(8192) {
            lines.extend(dec.process(chunk));
        }

        assert!(
            lines.len() >= height - 3,
            "expected ~{height} lines, got {}",
            lines.len()
        );

        // Compare a settled middle decoded line against the best-matching input
        // line over the non-sync region.
        let li = lines.len() / 2;
        let dec_line: Vec<f32> = lines[li][100..2000].iter().map(|&p| p as f32).collect();
        let mut best = -1.0f32;
        for iy in 0..height {
            let in_line: Vec<f32> = img[iy][100..2000].iter().map(|&p| p as f32).collect();
            best = best.max(pearson(&dec_line, &in_line));
        }

        // dump for visual inspection
        let out_img: Vec<Vec<u8>> = lines.clone();
        write_pgm("/tmp/apt_input.pgm", &img, width);
        write_pgm("/tmp/apt_decoded.pgm", &out_img, width);
        eprintln!("decoded {} lines, best line correlation = {best:.3}", lines.len());

        assert!(best > 0.85, "decoded image correlation too low: {best:.3}");
    }
}
