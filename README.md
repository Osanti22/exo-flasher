# Exo Flasher

A **browser-based USB flasher** for the Edgerun exoskeleton controller (ESP32-S3).
Open a web page, plug in a unit, click **Flash** - done. No downloads, no command
line, no ESP-IDF, no drivers to install.

Live page: **https://osanti22.github.io/exo-flasher/**

The site is fully static (`index.html`, `styles.css`, `app.js`, and a vendored copy of
esptool-js), served by GitHub Pages. All the flashing happens locally in your browser
over [WebSerial](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API) with
[esptool-js](https://github.com/espressif/esptool-js). Nothing is uploaded to a server.

**No firmware is hosted here.** The `.bin` files are not in this repo and not on the
page - they are sent to the client directly, and the client picks the file from their
own PC to flash it. This keeps the images off the public site.

The page also shows a live progress bar, the connected device's info (chip, MAC, flash
size), and a Logs and console panel with its own serial monitor. The monitor opens a
port of its own, separate from the flashing port, so you can flash on one port and
watch a board's logs on another (or on the same board after flashing).

---

## For testers

You do not need to install anything. You need a supported browser, a data USB
cable, and about a minute.

### 1. Use a supported browser

WebSerial is a Chromium feature, so you must use one of:

- **Chrome** or **Edge** on desktop (Windows, macOS, Linux) - recommended
- **Chrome 148 or newer on Android**

It will **not** work in:

- **Safari** (any version) or **anything on iPhone / iPad** - iOS has no WebSerial
- **Firefox** - no WebSerial support

### 2. Use a real data USB cable

Many cheap USB cables are **charge-only** and carry power but no data. If the board
never shows up in the port picker, the cable is the usual culprit - swap it for one
you know can transfer data.

### 3. Flash it

1. Save the firmware files we sent you somewhere you can find them.
2. Go to **https://osanti22.github.io/exo-flasher/**
3. Plug the exoskeleton unit into your computer/phone with the USB cable.
4. Click **Connect** and, in the browser's port picker, choose the serial port for
   the board (often shown as *USB JTAG/serial debug unit* or a `USB Serial` /
   `ttyACM` / `COM` device). The page then shows the board's chip, MAC, and flash size.
5. Pick the mode:
   - **Update (default)** keeps the unit's calibration and WiFi. Choose the **app**
     file we sent (and the **GUI** file if we included one). Nothing else - the boot
     table is written for you.
   - **Recovery (full)** rewrites everything and **erases calibration and WiFi**. Only
     use it if we tell you to (a bricked or brand-new unit). It takes one merged `.bin`.
6. Click **Flash** and watch the progress bar. Do not unplug the board while it runs.
   It resets and shows the boot log on its own when done.

### 4. Confirm it worked

When flashing finishes, the board resets into the new firmware on its own and the
**Logs and console** panel starts showing its boot log automatically - you do not have
to press anything. (You can also open the Logs monitor by hand any time with **Open**.)

Look for the **IMU boot line**. It will be one of these two, depending on the
hardware revision the board auto-detects:

```
IMU LH up (V3.1 single: ... PCA9534@0x20 ...)
```

or

```
IMU LH up (Version#1 single: ... direct-GPIO ...)
```

Either line means the firmware booted and brought the IMU up successfully. You do
**not** need to know which board you have - the firmware detects its own hardware
revision at boot and picks the right driver. Seeing one of those two lines is your
"success" signal.

If you see neither line (or the log stalls / repeats), note what the Logs console
shows and report it.

---

## For maintainers

### Two flashing modes

The page has two modes. Send the client the files for the mode they need:

- **Update** (default, keeps calibration + WiFi) writes only the changed partitions as
  separate segments and never touches `nvs` at `0x9000`. Send the raw build files:
  `exoskeleton_main_firmware.bin` (app, required) and `www.bin` (GUI, optional). You do
  NOT send `ota_data` - the page writes a blank `0x2000` boot table itself, which makes
  the unit boot `ota_0` (the app you just wrote), whatever slot it ran before.
- **Recovery** (full, erases calibration + WiFi) writes one merged image at `0x0`. Send
  the merged `.bin` from `build-image.sh`. For bricked or fresh units only.

### Making a Recovery image to send to a client

Firmware is not hosted here. To turn an ESP-IDF build into one flashable file, use
`build-image.sh`. It takes the **build directory** and a short **label** and merges
the 5 build artifacts into a single `.bin`:

```bash
./build-image.sh /path/to/firmware/build d0ee616
```

By default the file is written to the repo's **parent** directory
(`../exo-fw-d0ee616-esp32s3.bin`) so it never lands inside the repo. Use `-o <path>`
to put it somewhere else. Send that file to the client - they pick it from their PC in
the page and flash it. Nothing is committed and nothing is hosted. (As a backstop,
`.gitignore` blocks `*.bin` from ever being committed.)

> The build directory is the ESP-IDF `build/` folder and must contain:
> `bootloader/bootloader.bin`, `partition_table/partition-table.bin`,
> `ota_data_initial.bin`, `exoskeleton_main_firmware.bin`, and `www.bin`.

### How the flash write is set up

The page flashes every image the same way, and it is deliberate:

- **One merged bin, written whole at offset 0.** All the segments (bootloader,
  partition table, OTA data, app, web assets) are already baked into the single file
  at their correct offsets, so the flasher writes it starting at address 0.
- **No full erase, and the header is left as-is.** `app.js` flashes with
  `eraseAll: false` and `flashMode/flashFreq/flashSize: "keep"`, so esptool-js writes
  the bytes unchanged. A full erase would wipe **NVS**, where each unit's
  **calibration** (encoder offsets, IMU cal) lives. The merged image ends at
  `0x930000`; everything above it, including calibration, is never touched.

This lives in the `writeFlash` call in `app.js`. Do not change it to an erase-all or
per-segment write without the real partition table, or you can wipe calibration.

### Updating esptool-js

esptool-js is vendored under `vendor/esptool-js/` so there is no build step and no
runtime CDN dependency. To bump it:

```bash
npm pack esptool-js@<version>
tar xzf esptool-js-<version>.tgz
cp package/bundle.js vendor/esptool-js/bundle.js
# then update vendor/esptool-js/VERSION.txt
```

Keep using `bundle.js` - it is the self-contained ESM build with no bare imports, so
it works directly in the browser.

---

## Notes and limitations

- **Chromium + HTTPS only.** WebSerial exists only in Chromium browsers (Chrome,
  Edge, Chrome for Android) and only over HTTPS (or `localhost`). GitHub Pages
  serves the site over HTTPS, so that requirement is already met - but Safari,
  iOS, and Firefox simply cannot flash.
- **Firmware is never hosted here.** This is a public repo on a public Pages site, so
  no `.bin` goes in it - `.gitignore` blocks `*.bin` as a backstop. Send images to the
  client directly and let them pick the file from their PC. (Note: earlier commits did
  contain firmware images before this change; those remain in git history.)
- **This is USB flashing, not OTA.** This tool is a *host-push* flow: your computer
  pushes firmware to the board over the USB cable. It is completely separate from
  the exoskeleton's over-the-air update path, which is *device-pull* (the device
  fetches its own update over Wi-Fi). Use this when a unit is on the bench and
  cabled up; use OTA for units in the field.

---

## One-time repo setup (reference)

For the record, the exact commands used to create this repo and turn on GitHub
Pages. You only ever run these **once**, when first standing up the repo:

```bash
# create the public repo from the current folder and push it
gh repo create Osanti22/exo-flasher --public --source=. --remote=origin --push

# enable GitHub Pages, serving the repo root of the main branch
gh api -X POST repos/Osanti22/exo-flasher/pages \
  -f 'source[branch]=main' \
  -f 'source[path]=/'
```

After that, changes to the page are just: edit the files, commit, and push. To make a
firmware image for a client, run `build-image.sh` and send them the resulting `.bin`.
