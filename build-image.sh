#!/usr/bin/env bash
#
# build-image.sh - merge an ESP-IDF build into one flashable image to hand to a client.
#
# It merges the 5 ESP-IDF build artifacts into a single merged .bin (offset 0) that
# the flasher page can write. Firmware is NEVER hosted in this repo - you send the
# resulting .bin to the client directly, and they pick it from their PC in the page.
#
# The output goes OUTSIDE the repo by default (or wherever -o points) so a firmware
# image is never accidentally committed. .gitignore also blocks *.bin as a backstop.
#
# Usage:
#   ./build-image.sh <build-dir> <label> [-o <output.bin>]
#   ./build-image.sh -h | --help
#
# Example:
#   ./build-image.sh ../firmware/build d0ee616
#   ./build-image.sh ../firmware/build d0ee616 -o ~/to-send/exo-d0ee616.bin

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

usage() {
  cat <<'EOF'
build-image.sh - merge an ESP-IDF build into one flashable image to hand to a client.

USAGE:
  ./build-image.sh <build-dir> <label> [-o <output.bin>]
  ./build-image.sh -h | --help

ARGS:
  <build-dir>   ESP-IDF build directory. Must contain:
                  bootloader/bootloader.bin
                  partition_table/partition-table.bin
                  ota_data_initial.bin
                  exoskeleton_main_firmware.bin
                  www.bin
  <label>       Short label for the file name, e.g. a git short SHA (d0ee616).
  -o <path>     Output file. Default: ../exo-fw-<label>-esp32s3.bin (outside the repo).

WHAT IT DOES:
  Merges the 5 build images into one .bin (offset 0) with esptool merge-bin:
    --chip esp32s3 --flash-mode dio --flash-freq 80m --flash-size 16MB
  Then prints where the file is. Send that file to the client - they flash it from
  their own PC in the page. Nothing is hosted or committed.

EXAMPLE:
  ./build-image.sh ../firmware/build d0ee616
EOF
}

# --- arg parsing --------------------------------------------------------------
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then usage; exit 0; fi

OUT_BIN_PATH=""
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output) OUT_BIN_PATH="$2"; shift 2 ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done

if [[ ${#POSITIONAL[@]} -lt 2 ]]; then
  echo "ERROR: need <build-dir> and <label>." >&2
  echo >&2
  usage >&2
  exit 2
fi

BUILD_DIR="${POSITIONAL[0]}"
LABEL="${POSITIONAL[1]}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# default output is the repo's PARENT dir, so an image never lands inside the repo
[[ -z "$OUT_BIN_PATH" ]] && OUT_BIN_PATH="$(cd "${SCRIPT_DIR}/.." && pwd)/exo-fw-${LABEL}-esp32s3.bin"

# --- sanity checks ------------------------------------------------------------
echo "==> Checking prerequisites"
if ! python3 -m esptool version >/dev/null 2>&1; then
  echo "ERROR: esptool is not available via 'python3 -m esptool'." >&2
  echo "       Install:  python3 -m pip install esptool   (or activate ESP-IDF: . \$IDF_PATH/export.sh)" >&2
  exit 1
fi
echo "    esptool: OK ($(python3 -m esptool version 2>/dev/null | head -n1))"

if [[ ! -d "$BUILD_DIR" ]]; then echo "ERROR: build directory not found: $BUILD_DIR" >&2; exit 1; fi
echo "    build dir: $BUILD_DIR"

missing=0
for rel in "$REL_BOOTLOADER" "$REL_PARTTABLE" "$REL_OTADATA" "$REL_APP" "$REL_WWW"; do
  if [[ ! -f "${BUILD_DIR}/${rel}" ]]; then
    echo "ERROR: missing build artifact: ${BUILD_DIR}/${rel}" >&2; missing=1
  fi
done
[[ "$missing" -ne 0 ]] && { echo "ERROR: required build artifacts missing (see above)." >&2; exit 1; }
echo "    all 5 build artifacts present"

[[ -e "$OUT_BIN_PATH" ]] && echo "WARNING: $OUT_BIN_PATH exists and will be overwritten." >&2

# --- merge --------------------------------------------------------------------
echo "==> Merging firmware (offset 0)"
echo "    chip=$CHIP mode=$FLASH_MODE freq=$FLASH_FREQ size=$FLASH_SIZE"
mkdir -p "$(dirname "$OUT_BIN_PATH")"

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

[[ -s "$OUT_BIN_PATH" ]] || { echo "ERROR: merge produced no output." >&2; exit 1; }

cat <<EOF

==> Done.
      $OUT_BIN_PATH  ($(du -h "$OUT_BIN_PATH" | cut -f1))

Send this file to the client. In the flasher page they click Connect, then pick this
.bin from their PC and Flash. Do not commit it - firmware images are not hosted here.
EOF
