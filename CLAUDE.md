# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static, browser-based USB flasher for the Edgerun exoskeleton controller (ESP32-S3), served by GitHub Pages at https://osanti22.github.io/exo-flasher/. Flashing runs entirely in the browser over WebSerial; nothing is uploaded to a server. There is no build step, no framework, no package.json - "deploy" = push to `main`.

**No firmware is hosted here.** The `.bin` images are not in the repo and not on the page; `.gitignore` blocks `*.bin`. Images are sent to the client directly, and the client picks the file from their own PC in the page. This is deliberate - the repo and Pages site are public, so hosting firmware would expose it. (Earlier commits did contain images before this change; they remain in git history. There was no history rewrite.)

The flasher drives `esptool-js` directly (vendored, pinned) so the page owns the whole flow: a custom progress bar, an in-page logs/serial console, a device-info readout (chip, revision, MAC, flash size), a Reset button (reboot the board on demand), and auto-reset into the bootloader on connect (no BOOT button). It used to use the `esp-web-tools` web component; that closed modal was replaced so we control the UI.

## File layout

- `index.html` - page shell only (markup + element ids).
- `styles.css` - all styling (dark, card-based).
- `app.js` - ES module, the whole app: connect + flash a user-picked `.bin`, device info, and an independent Logs monitor. Two separate serial ports: the flash port (esptool) and the Logs port (its own `requestPort`), so flashing and log-watching don't share a connection. After a successful flash it auto-resets the board and auto-opens the Logs monitor (`autoResetAndLog` -> `beginLog`); on a single-port board the flash port is handed to the monitor, on two ports an already-open monitor just shows the reboot.
- `vendor/esptool-js/bundle.js` - vendored self-contained ESM build of esptool-js (no runtime CDN). `VERSION.txt` says which version and how to bump it.
- `build-image.sh` - merges an ESP-IDF build into one `.bin` to hand to a client. Does not host or commit anything.
- `.gitignore` - blocks `*.bin` so a firmware image can never be committed.

## Making an image to send to a client

```bash
./build-image.sh <esp-idf-build-dir> <label> [-o <output.bin>]
```

It merges the 5 ESP-IDF build artifacts into one merged `.bin` (offset 0) with `esptool merge-bin`. By default it writes to the repo's parent dir (`../exo-fw-<label>-esp32s3.bin`) so nothing lands inside the repo. It needs `esptool` on the path (`python3 -m esptool`, e.g. from an activated ESP-IDF env). Send the resulting file to the client; they flash it from their PC.

There are no tests, no lint, no CI. Verify the page by serving locally (`python3 -m http.server`) and opening in Chrome/Edge - WebSerial needs Chromium + HTTPS or localhost; it will not run from a `file://` path or in Safari/Firefox. Actual flashing needs a board plugged in and a merged `.bin` to pick.

## Things that will bite you if you don't know them

- **Never commit a firmware `.bin`.** The repo and Pages site are public. `.gitignore` blocks `*.bin`; keep it that way. `build-image.sh` writes outside the repo on purpose.
- **Two flash modes, both `eraseAll: false` and `flashMode/flashFreq/flashSize: "keep"`** (`"keep"` writes the bytes as-is, no header patching). See `buildFileArray` / `flash` in `app.js`.
  - **Update (default):** writes separate segments - a UI-generated blank `ota_data` (`0x2000` of `0xFF`, `OTADATA_SIZE`) at `0xf000`, the app at `0x20000`, optional `www` at `0x830000`. It never touches `nvs` at `0x9000`, so calibration + WiFi survive. It MUST write the blank `ota_data` (with no factory partition, a blank boot selector boots `ota_0`, so the unit runs the app you just wrote regardless of the slot it ran before), and MUST pass separate `fileArray` entries - a merged blob spans the `nvs` gap and erases it. The tester supplies only app (+ optional www); no `ota_data` file. Offsets are the `*_OFFSET` constants; the app is validated to start with `0xE9`.
  - **Recovery:** the single merged image written whole at `0x0` (spans `0x0`-`0x930000`, wipes `nvs`). For bricked/fresh units only; the UI confirms before running it.
  - Do not "improve" Update into an erase-all or merged write, and do not drop `ota_data` - either wipes or ignores per-unit state.
- **The image the user picks must be a merged image** (bootloader through www at their real offsets), which is exactly what `build-image.sh` produces. `app.js` warns if the file does not start with `0xE9` (ESP image magic) but still lets it through.
- **Flash params are fixed for these boards** and hardcoded in `build-image.sh`: `--chip esp32s3 --flash-mode dio --flash-freq 80m --flash-size 16MB`. The build dir must contain `bootloader/bootloader.bin`, `partition_table/partition-table.bin`, `ota_data_initial.bin`, `exoskeleton_main_firmware.bin`, `www.bin`.
- **One image, two board revisions.** The firmware auto-detects V3.1 vs Version #1 at boot and picks the IMU driver. The tester "success" signal is one of the two `IMU LH up (...)` lines in the serial log; `app.js` highlights any line containing the `IMU_OK` substring in the Logs console. Update `IMU_OK` if the firmware boot banner changes.
- **The native USB re-enumerates on reset.** The firmware console is on the same USB-Serial-JTAG used to flash (`CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y`). When the S3 resets into the app, that USB drops off the bus and comes back as a fresh port - do NOT assume the old `SerialPort` handle survives. The Logs monitor handles this: `readLogLoop` ends on the drop, `enterReconnectWait` waits, and it reopens automatically via the `navigator.serial` `'connect'` event (`onSerialConnect`, matching the board by VID `0x303a` / PID `0x1001`, `BOARD_VID`/`BOARD_JTAG_PID`) with a `getPorts()` poll fallback; `onSerialDisconnect` cancels a hung read. If auto-reopen can't get the port, the `logReconnectBtn` ("Reconnect monitor") lets the user re-pick it. The `IMU LH up` scan (`IMU_OK`) still runs on the resumed stream.
- **Serial baud.** `app.js` flashes at `FLASH_BAUD` (115200) - deliberately not higher, so esptool-js never switches baud on connect (a baud change can drop the native USB port). The exo boards use the ESP32-S3 native USB, which ignores the baud number and runs at full USB speed anyway. The Logs monitor baud is a separate, user-selectable setting (default 115200). Only raise `FLASH_BAUD` if a build ships on a real UART bridge.
- **To update esptool-js:** `npm pack esptool-js@<ver>`, copy `package/bundle.js` to `vendor/esptool-js/bundle.js`, bump `VERSION.txt`. The bundle must stay a self-contained ESM (no bare imports) so it works with no build step.

## Writing style (from global user instructions)

User-facing text in `README.md`, `index.html`, and commit bodies is aimed at non-native English readers: plain, direct English, ASCII hyphens only (no em/en dashes). No AI-attribution lines in commits or PRs.
