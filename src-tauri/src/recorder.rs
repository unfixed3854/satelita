//! NOAA APT live recorder.
//!
//! `rtl_fm` owns the SDR and streams FM-demodulated audio straight into a Rust
//! reader thread, which (a) appends the raw samples to `signal.raw` for the
//! final satdump decode, and (b) feeds them to an incremental [`AptDecoder`]
//! that emits image lines the moment they are decoded (~2 lines/second).
//!
//! Events emitted:
//!   - `apt-line`   { start_line, width, count, pixels_b64 }  (live, per batch)
//!   - `apt-final`  { data_url, width, height }               (satdump, on stop)
//!   - `apt-status` { state, message, elapsed_secs }

use std::io::{BufWriter, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::apt::{AptDecoder, APT_LINE_WIDTH};

const CAPTURE_RATE: u32 = 60_000; // rtl_fm FM-demod output rate (also the DSP rate)

/// Managed Tauri state: the single active recording session, if any.
#[derive(Default)]
pub struct RecorderState(pub Mutex<Option<Session>>);

/// A live recording session. Holds the rtl_fm child so shutdown is a direct
/// `kill()`, plus the reader/decoder thread.
pub struct Session {
    rtl: Child,
    stop: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
    run_dir: PathBuf,
    sat: String,
    start_epoch: u64,
}

#[derive(Clone, Serialize)]
struct LinePayload {
    start_line: usize,
    width: usize,
    count: usize,
    pixels_b64: String,
}

#[derive(Clone, Serialize)]
struct FinalPayload {
    data_url: String,
}

#[derive(Clone, Serialize)]
struct StatusPayload {
    state: String, // "recording" | "stopped" | "error"
    message: String,
    elapsed_secs: u64,
}

fn freq_for_sat(sat: &str) -> Option<&'static str> {
    match sat {
        "15" => Some("137.620M"),
        "18" => Some("137.9125M"),
        "19" => Some("137.100M"),
        _ => None,
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn emit_status(app: &AppHandle, state: &str, message: &str, elapsed: u64) {
    let _ = app.emit(
        "apt-status",
        StatusPayload {
            state: state.into(),
            message: message.into(),
            elapsed_secs: elapsed,
        },
    );
}

/// The reader/decoder loop: pull audio from rtl_fm, persist it, decode lines,
/// and emit them. Runs until `stop` is set or rtl_fm's stdout closes.
fn reader_loop(
    app: AppHandle,
    mut out: impl Read,
    raw_path: PathBuf,
    stop: Arc<AtomicBool>,
    start_epoch: u64,
) {
    let raw_file = match std::fs::File::create(&raw_path) {
        Ok(f) => f,
        Err(e) => {
            emit_status(&app, "error", &format!("Cannot write recording: {e}"), 0);
            return;
        }
    };
    let mut raw_w = BufWriter::new(raw_file);
    let mut decoder = AptDecoder::new(CAPTURE_RATE as f32);

    let mut buf = [0u8; 16384];
    let mut carry: Option<u8> = None;
    let mut samples: Vec<f32> = Vec::with_capacity(8192);
    let mut last_status = 0u64;

    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let n = match out.read(&mut buf) {
            Ok(0) => break, // rtl_fm closed
            Ok(n) => n,
            Err(_) => break,
        };
        let _ = raw_w.write_all(&buf[..n]);

        // Bytes -> i16 LE -> f32, carrying an odd trailing byte between reads.
        samples.clear();
        let mut idx = 0;
        if let Some(b0) = carry.take() {
            if n >= 1 {
                let s = i16::from_le_bytes([b0, buf[0]]);
                samples.push(s as f32 / 32768.0);
                idx = 1;
            } else {
                carry = Some(b0);
            }
        }
        while idx + 1 < n {
            let s = i16::from_le_bytes([buf[idx], buf[idx + 1]]);
            samples.push(s as f32 / 32768.0);
            idx += 2;
        }
        if idx < n {
            carry = Some(buf[idx]);
        }

        let start_line = decoder.lines_out;
        let lines = decoder.process(&samples);
        if !lines.is_empty() {
            let count = lines.len();
            let mut flat = Vec::with_capacity(count * APT_LINE_WIDTH);
            for l in &lines {
                flat.extend_from_slice(l);
            }
            let _ = app.emit(
                "apt-line",
                LinePayload {
                    start_line,
                    width: APT_LINE_WIDTH,
                    count,
                    pixels_b64: general_purpose::STANDARD.encode(&flat),
                },
            );
        }

        let elapsed = now_secs().saturating_sub(start_epoch);
        if elapsed != last_status {
            last_status = elapsed;
            let msg = if decoder.lines_out > 0 {
                format!("Live · {} lines", decoder.lines_out)
            } else {
                "Waiting for signal…".to_string()
            };
            emit_status(&app, "recording", &msg, elapsed);
        }
    }
    let _ = raw_w.flush();
}

/// Run satdump on the full recording for the polished final image.
fn final_decode(run_dir: &PathBuf, sat: &str, start_epoch: u64) -> Option<Vec<u8>> {
    let raw = run_dir.join("signal.raw");
    let snap = run_dir.join("snapshot.wav");
    let decode = run_dir.join("decode");
    match std::fs::metadata(&raw) {
        Ok(m) if m.len() > 0 => {}
        _ => return None,
    }
    let ok = Command::new("sox")
        .args([
            "-t", "raw", "-r", &CAPTURE_RATE.to_string(), "-e", "signed", "-b", "16", "-c", "1",
        ])
        .arg(&raw)
        .arg(&snap)
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        return None;
    }
    let _ = Command::new("satdump")
        .args(["legacy", "noaa_apt", "audio_wav"])
        .arg(&snap)
        .arg(&decode)
        .args([
            "--satellite_number",
            sat,
            "--start_timestamp",
            &start_epoch.to_string(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    std::fs::read(decode.join("raw_sync.png")).ok()
}

#[tauri::command]
pub fn start_recording(
    app: AppHandle,
    state: tauri::State<'_, RecorderState>,
    sat: String,
    gain: String,
    device: Option<u32>,
) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Err("Already recording — stop the current pass first.".into());
    }

    let freq = freq_for_sat(&sat).ok_or("Unknown satellite (use 15, 18 or 19).")?;
    let device = device.unwrap_or(0);
    let start_epoch = now_secs();

    let run_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("recordings")
        .join(format!("noaa{}-{}", sat, start_epoch));
    std::fs::create_dir_all(run_dir.join("decode")).map_err(|e| e.to_string())?;

    // --- rtl_fm owns the SDR, streaming FM audio to our reader ---------------
    let mut rtl_args: Vec<String> = vec![
        "-d".into(),
        device.to_string(),
        "-f".into(),
        freq.to_string(),
        "-M".into(),
        "fm".into(),
        "-s".into(),
        CAPTURE_RATE.to_string(),
        "-E".into(),
        "dc".into(),
        "-F".into(),
        "9".into(),
    ];
    if gain != "agc" && gain != "auto" {
        rtl_args.push("-g".into());
        rtl_args.push(gain.clone());
    }
    rtl_args.push("-".into());

    let rtl_log = std::fs::File::create(run_dir.join("rtl.log")).map_err(|e| e.to_string())?;
    let mut rtl = Command::new("rtl_fm")
        .args(&rtl_args)
        .stdout(Stdio::piped())
        .stderr(Stdio::from(rtl_log))
        .spawn()
        .map_err(|e| format!("Failed to start rtl_fm: {e}"))?;
    let rtl_out = rtl.stdout.take().ok_or("rtl_fm produced no stdout")?;

    let stop = Arc::new(AtomicBool::new(false));
    let stop_r = stop.clone();
    let app_r = app.clone();
    let raw_path = run_dir.join("signal.raw");
    let reader = thread::spawn(move || {
        reader_loop(app_r, rtl_out, raw_path, stop_r, start_epoch);
    });

    *guard = Some(Session {
        rtl,
        stop,
        reader: Some(reader),
        run_dir: run_dir.clone(),
        sat: sat.clone(),
        start_epoch,
    });

    emit_status(&app, "recording", &format!("Recording NOAA-{sat} on {freq}"), 0);
    Ok(format!("Recording NOAA-{sat} ({freq})"))
}

#[tauri::command]
pub fn stop_recording(
    app: AppHandle,
    state: tauri::State<'_, RecorderState>,
) -> Result<String, String> {
    let session = state.0.lock().map_err(|e| e.to_string())?.take();
    let mut session = session.ok_or("Not recording.")?;

    session.stop.store(true, Ordering::Relaxed);
    let _ = session.rtl.kill();
    let _ = session.rtl.wait();
    if let Some(r) = session.reader.take() {
        let _ = r.join();
    }

    let elapsed = now_secs().saturating_sub(session.start_epoch);
    emit_status(&app, "stopped", "Running final decode…", elapsed);

    // Do the (slow) satdump decode off the Tauri command thread's caller by
    // running it here synchronously — the UI already has the live image.
    let app_f = app.clone();
    let run_dir = session.run_dir.clone();
    let sat = session.sat.clone();
    let start_epoch = session.start_epoch;
    thread::spawn(move || {
        if let Some(png) = final_decode(&run_dir, &sat, start_epoch) {
            let data_url = format!(
                "data:image/png;base64,{}",
                general_purpose::STANDARD.encode(&png)
            );
            let _ = app_f.emit("apt-final", FinalPayload { data_url });
        }
        emit_status(
            &app_f,
            "stopped",
            &format!("Stopped. Files in {}", run_dir.display()),
            elapsed,
        );
    });

    Ok(session.run_dir.display().to_string())
}

/// Kill any active session's SDR process (used on window close).
pub fn abort_on_exit(app: &AppHandle) {
    if let Some(state) = app.try_state::<RecorderState>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(mut s) = guard.take() {
                s.stop.store(true, Ordering::Relaxed);
                let _ = s.rtl.kill();
            }
        }
    }
}
