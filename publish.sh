#!/usr/bin/env bash
#
# publish.sh — publish a new exoskeleton firmware version to this GitHub Pages
# flasher repo.
#
# It merges the ESP-IDF build artifacts into a single flashable image
# (exo-fw-<LABEL>-esp32s3.bin, offset 0) and writes a matching ESP Web Tools
# manifest (manifest-<LABEL>.json). It does NOT commit or push — it prints the
# exact commands for you to run.
#
# Usage:
#   ./publish.sh <build-dir> <version-label>
#   ./publish.sh -h | --help
#
# Example:
#   ./publish.sh ../firmware/build d0ee616

set -euo pipefail

# --- constants: flash params must match how these boards are flashed ----------
CHIP="esp32s3"
FLASH_MODE="dio"
FLASH_FREQ="80m"
FLASH_SIZE="16MB"

# offset -> filename (relative to the build dir), in flash order
OFF_BOOTLOADER="0x0"
OFF_PARTTABLE="0x8000"
OFF_OTADATA="0xf000"
OFF_APP="0x20000"
OFF_WWW="0x830000"

REL_BOOTLOADER="bootloader/bootloader.bin"
REL_PARTTABLE="partition_table/partition-table.bin"
REL_OTADATA="ota_data_initial.bin"
REL_APP="exoskeleton_main_firmware.bin"
REL_WWW="www.bin"

# --- usage --------------------------------------------------------------------
usage() {
  cat <<'EOF'
publish.sh — publish a new exoskeleton firmware version to the flasher repo.

USAGE:
  ./publish.sh <build-dir> <version-label>
  ./publish.sh -h | --help

ARGS:
  <build-dir>       ESP-IDF build directory. Must contain:
                      bootloader/bootloader.bin
                      partition_table/partition-table.bin
                      ota_data_initial.bin
                      exoskeleton_main_firmware.bin
                      www.bin
  <version-label>   Short version label, e.g. a git short SHA or a tag (d0ee616).

WHAT IT DOES:
  1. Merges the 5 build images into exo-fw-<LABEL>-esp32s3.bin (offset 0) using
     esptool merge-bin, with these flash params:
       --chip esp32s3 --flash-mode dio --flash-freq 80m --flash-size 16MB
  2. Writes manifest-<LABEL>.json (ESP Web Tools schema, ESP32-S3, offset 0,
     new_install_prompt_erase=false so NVS calibration is preserved).
  3. Prints the manual follow-up steps (edit index.html, git add/commit/push).

It does NOT commit or push.

EXAMPLE:
  ./publish.sh ../firmware/build d0ee616
EOF
}

# --- arg parsing --------------------------------------------------------------
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -ne 2 ]]; then
  echo "ERROR: expected 2 arguments, got $#." >&2
  echo >&2
  usage >&2
  exit 2
fi

BUILD_DIR="$1"
LABEL="$2"

# repo root = the directory this script lives in
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OUT_BIN="exo-fw-${LABEL}-esp32s3.bin"
OUT_BIN_PATH="${SCRIPT_DIR}/${OUT_BIN}"
OUT_MANIFEST="manifest-${LABEL}.json"
OUT_MANIFEST_PATH="${SCRIPT_DIR}/${OUT_MANIFEST}"

# --- sanity checks ------------------------------------------------------------
echo "==> Checking prerequisites"

# esptool available?
if ! python3 -m esptool version >/dev/null 2>&1; then
  echo "ERROR: esptool is not available via 'python3 -m esptool'." >&2
  echo "       Install it with:  python3 -m pip install esptool" >&2
  echo "       (or activate your ESP-IDF environment: . \$IDF_PATH/export.sh)" >&2
  exit 1
fi
echo "    esptool: OK ($(python3 -m esptool version 2>/dev/null | head -n1))"

# build dir exists?
if [[ ! -d "$BUILD_DIR" ]]; then
  echo "ERROR: build directory not found: $BUILD_DIR" >&2
  exit 1
fi
echo "    build dir: $BUILD_DIR"

# all 5 bins present?
missing=0
for rel in "$REL_BOOTLOADER" "$REL_PARTTABLE" "$REL_OTADATA" "$REL_APP" "$REL_WWW"; do
  if [[ ! -f "${BUILD_DIR}/${rel}" ]]; then
    echo "ERROR: missing build artifact: ${BUILD_DIR}/${rel}" >&2
    missing=1
  fi
done
if [[ "$missing" -ne 0 ]]; then
  echo "ERROR: one or more required build artifacts are missing (see above)." >&2
  exit 1
fi
echo "    all 5 build artifacts present"

# don't silently clobber an existing published bin for this label
if [[ -e "$OUT_BIN_PATH" ]]; then
  echo "WARNING: $OUT_BIN already exists and will be overwritten." >&2
fi
if [[ -e "$OUT_MANIFEST_PATH" ]]; then
  echo "WARNING: $OUT_MANIFEST already exists and will be overwritten." >&2
fi

# --- merge --------------------------------------------------------------------
echo "==> Merging firmware into $OUT_BIN (offset 0)"
echo "    chip=$CHIP mode=$FLASH_MODE freq=$FLASH_FREQ size=$FLASH_SIZE"

python3 -m esptool --chip "$CHIP" merge-bin \
  -o "$OUT_BIN_PATH" \
  --flash-mode "$FLASH_MODE" \
  --flash-freq "$FLASH_FREQ" \
  --flash-size "$FLASH_SIZE" \
  "$OFF_BOOTLOADER" "${BUILD_DIR}/${REL_BOOTLOADER}" \
  "$OFF_PARTTABLE"  "${BUILD_DIR}/${REL_PARTTABLE}" \
  "$OFF_OTADATA"    "${BUILD_DIR}/${REL_OTADATA}" \
  "$OFF_APP"        "${BUILD_DIR}/${REL_APP}" \
  "$OFF_WWW"        "${BUILD_DIR}/${REL_WWW}"

if [[ ! -s "$OUT_BIN_PATH" ]]; then
  echo "ERROR: merge produced no output ($OUT_BIN)." >&2
  exit 1
fi
echo "    wrote $OUT_BIN ($(du -h "$OUT_BIN_PATH" | cut -f1))"

# --- manifest -----------------------------------------------------------------
echo "==> Writing $OUT_MANIFEST"
cat > "$OUT_MANIFEST_PATH" <<EOF
{
  "name": "Exoskeleton Firmware",
  "version": "${LABEL}",
  "new_install_prompt_erase": false,
  "builds": [
    {
      "chipFamily": "ESP32-S3",
      "parts": [
        { "path": "${OUT_BIN}", "offset": 0 }
      ]
    }
  ]
}
EOF
echo "    wrote $OUT_MANIFEST"

# --- next steps ---------------------------------------------------------------
cat <<EOF

==> Done. Two files were created in the repo root:
      $OUT_BIN
      $OUT_MANIFEST

NEXT STEPS (manual — this script does not commit or push):

  1. Add this entry to the FIRMWARE_VERSIONS array in index.html
     (put it at the top so it becomes the default):

       { label: "${LABEL}", manifest: "./${OUT_MANIFEST}" },

  2. Commit and push (GitHub Pages will redeploy automatically):

       git add -A
       git commit -m "Add firmware ${LABEL}"
       git push

EOF
