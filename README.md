# Exo Flasher

A **browser-based USB flasher** for the Edgerun exoskeleton controller (ESP32-S3).
Open a web page, plug in a unit, click **Flash** — done. No downloads, no command
line, no ESP-IDF, no drivers to install.

Live page: **https://osanti22.github.io/exo-flasher/**

The site is fully static (just `index.html`, `manifest.json`, and a firmware `.bin`),
served by GitHub Pages. All the flashing happens locally in your browser over
[WebSerial](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API) via
[ESP Web Tools](https://esphome.github.io/esp-web-tools/). Nothing is uploaded to a
server.

---

## For testers

You do not need to install anything. You need a supported browser, a data USB
cable, and about a minute.

### 1. Use a supported browser

WebSerial is a Chromium feature, so you must use one of:

- **Chrome** or **Edge** on desktop (Windows, macOS, Linux) — recommended
- **Chrome 148 or newer on Android**

It will **not** work in:

- **Safari** (any version) or **anything on iPhone / iPad** — iOS has no WebSerial
- **Firefox** — no WebSerial support

### 2. Use a real data USB cable

Many cheap USB cables are **charge-only** and carry power but no data. If the board
never shows up in the port picker, the cable is the usual culprit — swap it for one
you know can transfer data.

### 3. Flash it

1. Go to **https://osanti22.github.io/exo-flasher/**
2. Plug the exoskeleton unit into your computer/phone with the USB cable.
3. (Optional) Pick the firmware version you want from the version dropdown. The
   default is the latest.
4. Click **Connect / Flash** (or "Install").
5. In the browser's port picker, choose the serial port for the board
   (often shown as *USB JTAG/serial debug unit* or a `USB Serial` / `ttyACM` /
   `COM` device) and click **Connect**.
6. Confirm the install prompt and wait. Flashing the ~9.6 MB image takes roughly
   a minute. Do not unplug the board while it runs.

### 4. Confirm it worked

Open the **Logs** console on the page (ESP Web Tools shows the device's serial
output after flashing). The board reboots on its own and prints its boot banner.

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
**not** need to know which board you have — the firmware detects its own hardware
revision at boot and picks the right driver. Seeing one of those two lines is your
"success" signal.

If you see neither line (or the log stalls / repeats), note what the Logs console
shows and report it.

---

## For maintainers

### Publishing a new firmware version

Use the included helper, `publish.sh`. It takes an ESP-IDF **build directory** and a
short **version label** (a git short SHA or a tag), merges the images into a single
flashable `.bin`, and writes a matching manifest:

```bash
./publish.sh /path/to/firmware/build d0ee616
```

That produces, in the repo root:

- `exo-fw-d0ee616-esp32s3.bin` — the merged, flashable image
- `manifest-d0ee616.json` — the ESP Web Tools manifest pointing at that bin

The script does **not** commit or push. After it runs, do the three manual steps it
reminds you about:

1. Add a dropdown entry in `index.html` (see below).
2. `git add -A`
3. `git commit -m "Add firmware d0ee616" && git push`

Once pushed, GitHub Pages redeploys the new files automatically (usually within a
minute).

> The build directory is the ESP-IDF `build/` folder and must contain:
> `bootloader/bootloader.bin`, `partition_table/partition-table.bin`,
> `ota_data_initial.bin`, `exoskeleton_main_firmware.bin`, and `www.bin`.

### Manifest format

The manifest is a standard [ESP Web Tools](https://esphome.github.io/esp-web-tools/)
manifest. `manifest.json` (the current default) looks like this:

```json
{
  "name": "Exoskeleton Firmware",
  "version": "d0ee616 — S3 board autodetect (V3.1 + Version #1)",
  "new_install_prompt_erase": false,
  "builds": [
    {
      "chipFamily": "ESP32-S3",
      "parts": [
        { "path": "exo-fw-d0ee616-esp32s3.bin", "offset": 0 }
      ]
    }
  ]
}
```

Key points:

- **`chipFamily` is `ESP32-S3`** — these are S3 boards.
- The image is a **merged bin flashed at `offset` 0**. All the individual segments
  (bootloader, partition table, OTA data, app, web assets) are already baked into
  the single file at their correct offsets, so ESP Web Tools just writes it starting
  at address 0.
- **`new_install_prompt_erase` is `false`** — this is deliberate. A full chip erase
  would wipe **NVS**, where each unit's **calibration** (encoder offsets, IMU cal,
  etc.) is stored. Leaving it `false` preserves per-unit calibration across a
  firmware update.

### The version dropdown in `index.html`

`index.html` keeps a small JavaScript array of the versions offered in the dropdown.
Each entry is a `{ label, manifest }` object, where `manifest` is a relative path to
a manifest file in this repo. It looks roughly like:

```js
const FIRMWARE_VERSIONS = [
  { label: "d0ee616 (latest) — S3 autodetect", manifest: "./manifest.json" },
  // add newer builds at the top:
  // { label: "<LABEL> — short description", manifest: "./manifest-<LABEL>.json" },
];
```

To expose a version you just published, add a new `{ label, manifest }` entry
pointing at the `manifest-<LABEL>.json` that `publish.sh` created. Put newer builds
at the top so the newest is the default. `publish.sh` prints the exact snippet to
paste.

---

## Notes and limitations

- **Chromium + HTTPS only.** WebSerial exists only in Chromium browsers (Chrome,
  Edge, Chrome for Android) and only over HTTPS (or `localhost`). GitHub Pages
  serves the site over HTTPS, so that requirement is already met — but Safari,
  iOS, and Firefox simply cannot flash.
- **The firmware binaries are PUBLIC.** This is a public repo on a public Pages
  site; anyone can download the `.bin`. **Never publish a firmware image that
  embeds secrets, private keys, Wi-Fi credentials, or tokens.** If a build bakes in
  anything sensitive, it does not belong here.
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

After that, every future release is just: run `publish.sh`, edit `index.html`,
commit, and push.
