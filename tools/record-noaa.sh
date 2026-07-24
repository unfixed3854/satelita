#!/usr/bin/env bash
#
# record-noaa.sh — record a NOAA APT pass with an RTL-SDR and watch the image
#                  decode live in the browser.
#
# One process (rtl_fm) owns the SDR and writes a headerless raw audio stream.
# A background loop periodically wraps the growing stream into a valid WAV and
# re-decodes it with satdump, refreshing raw_sync.png. A tiny http.server + an
# auto-refreshing page (tools/viewer.html) show the image building top-to-bottom.
#
# Usage:
#   tools/record-noaa.sh [--sat 15|18|19] [--gain 45|agc] [--device 0]
#                        [--freq 137.620M] [--timeout SECONDS] [--port 8137]
#
# Stop the pass with Ctrl-C (at LOS). A final full-quality decode runs on exit.

set -euo pipefail

# ---- defaults ---------------------------------------------------------------
SAT=15
GAIN=45
DEVICE=0
FREQ=""            # derived from SAT unless overridden
TIMEOUT=0          # 0 = run until Ctrl-C
PORT=8137
DECODE_EVERY=15    # seconds between live re-decodes
AUDIO_RATE=48000   # WAV rate fed to satdump
CAPTURE_RATE=60000 # rtl_fm FM-demod output rate

# ---- args -------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sat)     SAT="$2"; shift 2;;
    --gain)    GAIN="$2"; shift 2;;
    --device)  DEVICE="$2"; shift 2;;
    --freq)    FREQ="$2"; shift 2;;
    --timeout) TIMEOUT="$2"; shift 2;;
    --port)    PORT="$2"; shift 2;;
    --every)   DECODE_EVERY="$2"; shift 2;;
    -h|--help) grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "Unknown option: $1" >&2; exit 2;;
  esac
done

# NOAA APT downlink frequencies
if [[ -z "$FREQ" ]]; then
  case "$SAT" in
    15) FREQ=137.620M;;
    18) FREQ=137.9125M;;
    19) FREQ=137.100M;;
    *)  echo "Unknown sat '$SAT' (use 15/18/19) or pass --freq" >&2; exit 2;;
  esac
fi

# ---- workspace --------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
RUN="${SCRIPT_DIR}/../recordings/noaa${SAT}-${STAMP}"
RUN="$(mkdir -p "$RUN" && cd "$RUN" && pwd)"
RAW="${RUN}/signal.raw"       # growing headerless s16 mono @ AUDIO_RATE
SNAP="${RUN}/snapshot.wav"    # per-cycle valid WAV
DECODE="${RUN}/decode"        # satdump output dir
WWW="${RUN}/www"              # served to the browser
mkdir -p "$DECODE" "$WWW"
cp "${SCRIPT_DIR}/viewer.html" "${WWW}/index.html"

echo "=============================================================="
echo " NOAA-${SAT} APT  |  ${FREQ}  |  gain ${GAIN}  |  device ${DEVICE}"
echo " recording dir : ${RUN}"
echo " live viewer   : http://localhost:${PORT}/"
echo " stop with Ctrl-C (a final decode runs on exit)"
echo "=============================================================="

# ---- pids / cleanup ---------------------------------------------------------
CAP_PID=""; LOOP_PID=""; SRV_PID=""
STOP=0

decode_once() {
  # Wrap current raw stream into a valid WAV, then decode it with satdump.
  # Writes raw_sync.png into $WWW when a partial image is available.
  [[ -s "$RAW" ]] || return 0
  sox -t raw -r "$AUDIO_RATE" -e signed -b 16 -c 1 "$RAW" "$SNAP" 2>/dev/null || return 0
  # --start_timestamp lets satdump georeference/project the pass and build
  # the false-color composites & map overlays for the final products.
  local ts_args=()
  [[ -n "${START_EPOCH:-}" ]] && ts_args=(--start_timestamp "$START_EPOCH")
  satdump legacy noaa_apt audio_wav "$SNAP" "$DECODE" \
      --satellite_number "$SAT" "${ts_args[@]}" >/dev/null 2>&1 || true
  if [[ -f "${DECODE}/raw_sync.png" ]]; then
    cp -f "${DECODE}/raw_sync.png" "${WWW}/raw_sync.png.tmp" 2>/dev/null \
      && mv -f "${WWW}/raw_sync.png.tmp" "${WWW}/raw_sync.png"
  fi
}

# Kill an entire process group (pipeline members: rtl_fm, sox, satdump, ...).
# The jobs are started under `set -m`, so each has its own PGID == its PID.
kill_group() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  kill -TERM -- "-${pid}" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
}

cleanup() {
  [[ "$STOP" == 1 ]] && return
  STOP=1
  echo; echo "--- stopping capture, running final decode ---"
  kill_group "$CAP_PID"
  kill_group "$LOOP_PID"
  sleep 1
  # SIGKILL any survivor so the SDR is definitely released
  [[ -n "$CAP_PID" ]] && kill -KILL -- "-${CAP_PID}" 2>/dev/null || true
  decode_once
  [[ -n "$SRV_PID" ]] && kill "$SRV_PID" 2>/dev/null || true
  echo
  echo "Done. Artifacts:"
  echo "  raw audio  : ${RAW}"
  echo "  final WAV  : ${SNAP}"
  echo "  decode dir : ${DECODE}  (raw_sync.png, products, etc.)"
  echo "  final image: ${WWW}/raw_sync.png"
}
trap cleanup INT TERM EXIT

# ---- start the web viewer ---------------------------------------------------
( cd "$WWW" && exec python3 -m http.server "$PORT" >/dev/null 2>&1 ) &
SRV_PID=$!
( command -v xdg-open >/dev/null && xdg-open "http://localhost:${PORT}/" >/dev/null 2>&1 ) || true

# ---- start capture (rtl_fm owns the SDR) ------------------------------------
GAIN_ARGS=(-g "$GAIN")
[[ "$GAIN" == "agc" || "$GAIN" == "auto" ]] && GAIN_ARGS=()

START_EPOCH="$(date +%s)"   # start-of-recording, for satdump projections
set -m   # each backgrounded pipeline gets its own process group (PGID == $!)
(
  rtl_fm -d "$DEVICE" -f "$FREQ" -M fm -s "$CAPTURE_RATE" -E dc -F 9 "${GAIN_ARGS[@]}" - \
    | sox -t raw -r "$CAPTURE_RATE" -e signed -b 16 -c 1 - \
          -t raw -r "$AUDIO_RATE"  -e signed -b 16 -c 1 "$RAW"
) &
CAP_PID=$!

# ---- live decode loop -------------------------------------------------------
(
  while true; do
    sleep "$DECODE_EVERY"
    decode_once
  done
) &
LOOP_PID=$!
set +m

# ---- wait (respect optional timeout) ----------------------------------------
if [[ "$TIMEOUT" -gt 0 ]]; then
  echo "Auto-stop in ${TIMEOUT}s."
  SECONDS=0
  while [[ $SECONDS -lt $TIMEOUT ]]; do
    kill -0 "$CAP_PID" 2>/dev/null || break
    sleep 1
  done
else
  wait "$CAP_PID" 2>/dev/null || true
fi
cleanup
