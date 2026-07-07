// Exoskeleton Firmware Flasher - browser flashing over WebSerial with esptool-js.
//
// Everything runs in the visitor's browser. We talk to the ESP32-S3 straight over
// the USB cable; nothing is uploaded to a server. No firmware is hosted here: the
// user picks a merged .bin from their own PC (we send them the image directly).
//
// esptool-js is vendored (see vendor/esptool-js/) so there is no runtime CDN
// dependency and the version is pinned.

import { ESPLoader, Transport } from "./vendor/esptool-js/bundle.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const EXPECTED_CHIP = "ESP32-S3";
// Keep flashing at 115200 so esptool-js never switches baud during connect. These
// boards use the ESP32-S3 native USB, which ignores the baud number and runs at full
// USB speed regardless - so 115200 is just as fast and avoids a "port lost" on the
// baud change. Only raise this if a build ever ships on a real UART bridge.
const FLASH_BAUD = 115200;
const APP_BAUD = 115200;     // serial monitor speed for reading the boot log
const FLASH_OFFSET = 0;      // merged image is written whole at 0 (bootloader..www)

// The "IMU LH up" lines the firmware prints on a good boot. Success is one of these.
const IMU_OK = "IMU LH up";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let port = null;          // the SerialPort chosen in the browser picker
let transport = null;     // esptool-js Transport wrapping the port
let esploader = null;     // esptool-js loader (held open while connected)
let connected = false;    // true once we are synced with the bootloader
let flashing = false;
let monitoring = false;   // true while the serial monitor is reading the app
let appReader = null;     // reader used by the serial monitor
let localFile = null;     // the .bin chosen from disk

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const els = {};
[
  "unsupported", "app", "statusPill",
  "connectBtn", "disconnectBtn", "resetBtn",
  "deviceInfo", "diChip", "diRev", "diMac", "diFlash", "diFeatures",
  "fileInput", "fileDrop", "fileMeta",
  "flashBtn", "monitorBtn",
  "progressWrap", "progressBar", "progressPhase", "progressPct",
  "tabGuide", "tabLogs", "panelGuide", "panelLogs",
  "console", "clearLogBtn", "copyLogBtn", "logBadge",
].forEach((id) => (els[id] = $(id)));

function setStatus(text, kind) {
  els.statusPill.textContent = text;
  els.statusPill.className = "pill " + (kind || "");
}

function logLine(text, kind) {
  const con = els.console;
  const atBottom = con.scrollHeight - con.scrollTop - con.clientHeight < 40;
  const span = document.createElement("span");
  span.className = "log-line" + (kind ? " " + kind : "");
  span.textContent = text.endsWith("\n") ? text : text + "\n";
  con.appendChild(span);
  if (atBottom) con.scrollTop = con.scrollHeight;
  // highlight the success line so testers spot it
  if (text.includes(IMU_OK)) {
    span.classList.add("ok");
    els.logBadge.hidden = false;
  }
}

// esptool-js terminal: routes the loader's own output into the Logs console.
const terminal = {
  clean() { /* keep history; do not wipe the console */ },
  writeLine(data) { logLine(data, "dim"); },
  write(data) { logLine(data, "dim"); },
};

// ---------------------------------------------------------------------------
// Firmware file (picked from the user's PC)
// ---------------------------------------------------------------------------
function pickFile(file) {
  localFile = file || null;
  if (localFile) {
    els.fileMeta.hidden = false;
    els.fileMeta.textContent = `${localFile.name}  -  ${(localFile.size / 1048576).toFixed(2)} MB`;
  } else {
    els.fileMeta.hidden = true;
  }
  updateFlashEnabled();
}

function updateFlashEnabled() {
  els.flashBtn.disabled = !(connected && localFile && !flashing);
}

// ---------------------------------------------------------------------------
// Connect / device info
// ---------------------------------------------------------------------------
async function connect() {
  if (flashing) return;
  await stopMonitor();                  // in case a monitor was running
  if (connected) await hardCleanup();   // "Reconnect": drop the old port first
  try {
    port = await navigator.serial.requestPort();
  } catch (e) {
    logLine("No port selected.", "warn");
    return;
  }
  // Auto-reset into the bootloader, no button press. esptool-js picks the reset
  // for us: a native USB-Serial-JTAG board (PID 0x1001) gets the USB-JTAG reset,
  // anything else gets the classic DTR/RTS auto-reset - same as esptool.py's
  // default-reset. We then try a small ladder so custom boards work too:
  //   - native USB (0x1001): default (USB-JTAG) -> no_reset (if user held BOOT)
  //   - bridge / custom PID:  default (classic) -> usb_reset (native, odd PID) -> no_reset
  const info = (port.getInfo && port.getInfo()) || {};
  const isNativeUsbJtag = info.usbProductId === 0x1001;
  logLine(
    `Port VID 0x${(info.usbVendorId || 0).toString(16)} PID 0x${(info.usbProductId || 0).toString(16)}` +
      (isNativeUsbJtag ? " - ESP32-S3 native USB-JTAG (auto reset)" : " - UART bridge / custom (auto reset via DTR/RTS)"),
    "dim"
  );
  const resetModes = isNativeUsbJtag
    ? ["default_reset", "no_reset"]
    : ["default_reset", "usb_reset", "no_reset"];

  setStatus("Connecting...", "busy");
  els.connectBtn.disabled = true;
  let ok = false, lastErr = null;
  for (const mode of resetModes) {
    try {
      logLine(`Connecting (reset: ${mode.replace(/_/g, " ")})...`, "dim");
      transport = new Transport(port, false);
      esploader = new ESPLoader({ transport, baudrate: FLASH_BAUD, terminal, debugLogging: false });
      const chipDesc = await esploader.main(mode);   // resets, detects, loads stub, syncs
      if (!esploader.chip.CHIP_NAME || !esploader.chip.CHIP_NAME.includes("ESP32-S3")) {
        logLine(`Warning: connected chip is ${esploader.chip.CHIP_NAME}, expected ${EXPECTED_CHIP}.`, "warn");
      }
      await readDeviceInfo(chipDesc);
      ok = true;
      break;
    } catch (e) {
      lastErr = e;
      logLine(`Reset "${mode.replace(/_/g, " ")}" did not connect: ${e.message || e}`, "dim");
      try { await transport.disconnect(); } catch (_) {}
      transport = null;
      esploader = null;
    }
  }

  if (ok) {
    connected = true;
    setStatus("Connected", "ok");
    els.disconnectBtn.hidden = false;
    els.resetBtn.hidden = false;
    els.connectBtn.textContent = "Reconnect";
    updateFlashEnabled();
  } else {
    logLine("Connect failed: " + (lastErr && (lastErr.message || lastErr)), "err");
    logLine("Auto-reset did not work. If this is a custom board with no auto-reset circuit, hold BOOT while clicking Connect (release after the port picker). Also close any other program using the port (idf.py monitor, Arduino IDE, PuTTY) and use a data USB cable.", "warn");
    setStatus("Connect failed", "err");
    await hardCleanup();
  }
  els.connectBtn.disabled = false;
}

async function readDeviceInfo(chipDesc) {
  try {
    els.diChip.textContent = esploader.chip.CHIP_NAME || EXPECTED_CHIP;
    els.diRev.textContent = chipDesc || "-";
    els.diMac.textContent = await esploader.chip.readMac(esploader);
    const flashId = await esploader.readFlashId();
    const sizeId = (flashId >> 16) & 0xff;
    const bytes = 1 << sizeId;
    els.diFlash.textContent = bytes >= 1048576 ? (bytes / 1048576) + " MB" : bytes + " B";
    const feats = await esploader.chip.getChipFeatures(esploader);
    els.diFeatures.textContent = Array.isArray(feats) ? feats.join(", ") : String(feats);
    els.deviceInfo.hidden = false;
  } catch (e) {
    logLine("Could not read all device info: " + e.message, "warn");
    els.deviceInfo.hidden = false;
  }
}

// ---------------------------------------------------------------------------
// Flash
// ---------------------------------------------------------------------------
function setProgress(fraction, phase) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  els.progressBar.style.width = pct + "%";
  els.progressPct.textContent = pct + "%";
  if (phase) els.progressPhase.textContent = phase;
}

async function flash() {
  if (!connected || flashing || !localFile) return;
  flashing = true;
  els.flashBtn.disabled = true;
  els.monitorBtn.hidden = true;
  els.progressWrap.hidden = false;
  setStatus("Flashing", "busy");
  setProgress(0, "Reading firmware");

  try {
    const data = new Uint8Array(await localFile.arrayBuffer());
    if (data.length === 0) throw new Error("Firmware file is empty.");
    if (data[0] !== 0xe9) {
      logLine("Warning: image does not start with 0xE9 (ESP image magic). Is this a merged image for offset 0?", "warn");
    }
    logLine(`Flashing ${localFile.name} (${(data.length / 1048576).toFixed(2)} MB) at offset 0x0 (erase off, calibration preserved).`, "dim");
    setProgress(0, "Erasing and writing");

    await esploader.writeFlash({
      fileArray: [{ data, address: FLASH_OFFSET }],
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (_i, written, total) => setProgress(written / total, "Writing"),
    });

    setProgress(1, "Done");
    setStatus("Flashed OK", "ok");
    logLine("Flash complete. Open the serial monitor to see the boot log.", "ok");
    els.flashBtn.textContent = "Flash again";
    els.monitorBtn.hidden = false;
  } catch (e) {
    logLine("Flash failed: " + (e.message || e), "err");
    setStatus("Flash failed", "err");
    setProgress(0, "Failed");
  } finally {
    flashing = false;
    updateFlashEnabled();
  }
}

// ---------------------------------------------------------------------------
// Serial monitor (reads the board's boot log after flashing)
// ---------------------------------------------------------------------------
async function openMonitor() {
  if (!port || monitoring) return;
  showTab("logs");
  setStatus("Opening monitor", "busy");

  // Release esptool's hold on the port but keep the SerialPort object.
  try { if (transport) await transport.disconnect(); } catch (e) { /* ignore */ }
  connected = false;
  esploader = null;
  transport = null;
  els.connectBtn.textContent = "Connect";
  els.flashBtn.textContent = "Flash";
  els.deviceInfo.hidden = true;
  els.disconnectBtn.hidden = false;   // let the user stop the monitor
  els.resetBtn.hidden = false;        // reset stays available while watching
  updateFlashEnabled();

  try {
    await port.open({ baudRate: APP_BAUD });
  } catch (e) {
    logLine("Could not open serial monitor: " + e.message, "err");
    setStatus("Monitor failed", "err");
    return;
  }
  monitoring = true;
  setStatus("Serial monitor", "ok");
  els.monitorBtn.hidden = true;
  logLine("--- serial monitor open (" + APP_BAUD + " baud) - watching for '" + IMU_OK + "' ---", "dim");
  streamSerial();                     // start reading before we reset, so we catch the boot log
  await sleep(80);
  logLine("Resetting into the app...", "dim");
  els.logBadge.hidden = true;
  try { await pulseReset(); } catch (e) { logLine("Reset note: " + (e.message || e), "dim"); }
}

async function streamSerial() {
  const decoder = new TextDecoder();
  let buffer = "";
  let misses = 0;
  while (monitoring) {
    // On the native USB the port can briefly drop when the chip reboots; wait
    // for it to come back instead of ending the monitor.
    if (!port || !port.readable) {
      if (++misses > 50) { logLine("Serial port lost. Reconnect to continue.", "warn"); break; }
      await sleep(100);
      continue;
    }
    misses = 0;
    let reader;
    try {
      reader = port.readable.getReader();
      appReader = reader;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          logLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      }
    } catch (e) {
      if (monitoring) await sleep(100);   // transient read error, retry the loop
    } finally {
      try { reader && reader.releaseLock(); } catch (e) {}
    }
  }
}

async function stopMonitor() {
  if (!monitoring) return;
  monitoring = false;
  try { if (appReader) await appReader.cancel(); } catch (e) {}
  try { if (port) await port.close(); } catch (e) {}
  appReader = null;
}

// ---------------------------------------------------------------------------
// Reset the board (reboot into the app)
// ---------------------------------------------------------------------------

// Reboot into the app by pulsing only the reset line (RTS) - the same
// "Hard resetting via RTS pin" esptool uses. We must NOT touch DTR: on the
// ESP32-S3 native USB-Serial-JTAG, DTR drives GPIO0, and sending DTR events
// makes the chip fall into download mode ("waiting for download") instead of
// running the app. RTS-only resets straight into the app on both native USB
// and UART bridges.
async function pulseReset() {
  await port.setSignals({ requestToSend: true });   // EN low - hold in reset
  await sleep(100);
  await port.setSignals({ requestToSend: false });  // EN high - release, boots the app
}

async function resetBoard() {
  if (flashing) return;
  if (monitoring) {
    // The serial monitor owns the port: pulse reset and keep streaming the boot log.
    logLine("Resetting board (RTS pulse)...", "dim");
    els.logBadge.hidden = true;
    try { await pulseReset(); } catch (e) { logLine("Reset failed: " + (e.message || e), "err"); }
    return;
  }
  if (esploader) {
    // Still connected to the bootloader: hard reset into the app and open the
    // serial monitor so the boot log is visible.
    await openMonitor();
    return;
  }
  logLine("Connect to a board first, then Reset.", "warn");
}

// ---------------------------------------------------------------------------
// Disconnect / cleanup
// ---------------------------------------------------------------------------
async function disconnect() {
  await stopMonitor();
  await hardCleanup();
  setStatus("Disconnected", "");
  logLine("Disconnected.", "dim");
}

async function hardCleanup() {
  try { if (transport) await transport.disconnect(); } catch (e) {}
  try { if (port && !monitoring) await port.close(); } catch (e) {}
  connected = false;
  esploader = null;
  transport = null;
  port = null;
  els.deviceInfo.hidden = true;
  els.disconnectBtn.hidden = true;
  els.resetBtn.hidden = true;
  els.connectBtn.textContent = "Connect";
  els.flashBtn.textContent = "Flash";
  els.monitorBtn.hidden = true;
  updateFlashEnabled();
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function showTab(which) {
  const logs = which === "logs";
  els.tabGuide.classList.toggle("active", !logs);
  els.tabLogs.classList.toggle("active", logs);
  els.panelGuide.hidden = logs;
  els.panelLogs.hidden = !logs;
  if (logs) els.logBadge.hidden = true;
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------
function init() {
  if (!("serial" in navigator)) {
    els.unsupported.hidden = false;
    els.app.hidden = true;
    return;
  }

  els.connectBtn.addEventListener("click", connect);
  els.disconnectBtn.addEventListener("click", disconnect);
  els.resetBtn.addEventListener("click", resetBoard);
  els.flashBtn.addEventListener("click", flash);
  els.monitorBtn.addEventListener("click", openMonitor);

  els.fileInput.addEventListener("change", (e) => pickFile(e.target.files[0]));
  ["dragover", "dragenter"].forEach((ev) =>
    els.fileDrop.addEventListener(ev, (e) => { e.preventDefault(); els.fileDrop.classList.add("drag"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    els.fileDrop.addEventListener(ev, (e) => { e.preventDefault(); els.fileDrop.classList.remove("drag"); })
  );
  els.fileDrop.addEventListener("drop", (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files[0]) pickFile(e.dataTransfer.files[0]);
  });

  els.tabGuide.addEventListener("click", () => showTab("guide"));
  els.tabLogs.addEventListener("click", () => showTab("logs"));
  els.clearLogBtn.addEventListener("click", () => { els.console.textContent = ""; els.logBadge.hidden = true; });
  els.copyLogBtn.addEventListener("click", () => navigator.clipboard.writeText(els.console.textContent));

  window.addEventListener("beforeunload", () => { try { hardCleanup(); } catch (e) {} });

  setStatus("Disconnected", "");
}

init();
