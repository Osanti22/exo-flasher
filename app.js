// Exoskeleton Firmware Flasher - browser flashing over WebSerial with esptool-js.
//
// Everything runs in the visitor's browser. We talk to the ESP32-S3 straight over
// the USB cable; nothing is uploaded to a server. No firmware is hosted here: the
// user picks a merged .bin from their own PC (we send them the image directly).
//
// Two independent serial ports:
//   - the FLASH port (esptool-js): Connect / Flash / Reset board.
//   - the LOG port: the Logs & console panel opens its own port and streams until
//     Close. It is separate from the flash port, so you can flash on one port and
//     watch logs on another (or a second connection to the same board).
//
// esptool-js is vendored (see vendor/esptool-js/), so there is no runtime CDN
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
const FLASH_OFFSET = 0;      // Recovery: merged image written whole at 0 (bootloader..www)

// Update-mode segment offsets (fixed partition layout). nvs at 0x9000 is NOT in any
// segment, so an Update flash never erases calibration or WiFi.
const OTADATA_OFFSET = 0xf000;
const APP_OFFSET = 0x20000;
const WWW_OFFSET = 0x830000;
const OTADATA_SIZE = 0x2000;  // ota_data partition is 2 sectors (8 KB); we write it blank (0xFF)

// The "IMU LH up" lines the firmware prints on a good boot. Success is one of these.
const IMU_OK = "IMU LH up";

// ESP32-S3 native USB-Serial-JTAG identity - used to find the board when it
// re-enumerates after a reset.
const BOARD_VID = 0x303a;
const BOARD_JTAG_PID = 0x1001;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
// Flash port
let port = null;          // the SerialPort chosen for flashing
let transport = null;     // esptool-js Transport wrapping the flash port
let esploader = null;     // esptool-js loader (held open while connected)
let connected = false;    // true once we are synced with the bootloader
let flashing = false;
let flashMode = "update"; // "update" (keep nvs) | "recovery" (full merged image)
let localFile = null;     // Recovery: the merged .bin
let appImg = null;        // Update: app image -> 0x20000 (required)
let wwwImg = null;        // Update: GUI image -> 0x830000 (optional)
// Update also writes a blank ota_data (generated below), no file needed.

// Log port (independent serial monitor)
let logPort = null;
let logReader = null;
let logOpen = false;         // user wants the monitor open (stays true across a reboot drop)
let logReconnecting = false; // waiting for the board to re-enumerate after a reset
let logBaudRate = 115200;

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const els = {};
[
  "unsupported", "app", "statusPill",
  "connectBtn", "disconnectBtn", "resetBtn",
  "deviceInfo", "diChip", "diRev", "diMac", "diFlash", "diFeatures",
  "modeUpdate", "modeRecovery", "modeHint", "modeCallout", "updatePanel", "recoveryPanel",
  "appFile", "wwwFile", "appFileName", "wwwFileName",
  "fileInput", "fileDrop", "fileMeta",
  "flashBtn",
  "progressWrap", "progressBar", "progressPhase", "progressPct",
  "logOpenBtn", "logResetBtn", "logReconnectBtn", "logBaud", "clearLogBtn", "copyLogBtn", "saveLogBtn", "console",
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
  if (text.includes(IMU_OK)) span.classList.add("ok");   // highlight the success line
}

// esptool-js terminal: routes the loader's own output into the console.
const terminal = {
  clean() { /* keep history; do not wipe the console */ },
  writeLine(data) { logLine(data, "dim"); },
  write(data) { logLine(data, "dim"); },
};

// Reboot a board into the app, ESP32-S3 native USB-Serial-JTAG style. This matches
// what esptool.py does for a hard reset, and it matters HOW:
//   1. Settle DTR low on its own first (GPIO0 high = run) and let it settle. After
//      port.open() WebSerial leaves DTR asserted; with DTR==RTS the USB-JTAG reset
//      logic cancels, which is why a lone RTS toggle does nothing.
//   2. Then pulse ONLY RTS (EN low -> high). Changing DTR and RTS in the same message
//      looks like the "enter download" pattern, so we keep the edges separate.
async function pulseResetPort(p) {
  await p.setSignals({ dataTerminalReady: false });                        // GPIO0 high (run); settle
  await sleep(60);
  await p.setSignals({ dataTerminalReady: false, requestToSend: true });   // EN low (reset)
  await sleep(100);
  await p.setSignals({ dataTerminalReady: false, requestToSend: false });  // EN high -> run the app
}

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
  const ready = flashMode === "recovery" ? !!localFile : !!appImg;
  els.flashBtn.disabled = !(connected && ready && !flashing);
}

function setMode(mode) {
  flashMode = mode;
  els.modeUpdate.classList.toggle("active", mode === "update");
  els.modeRecovery.classList.toggle("active", mode === "recovery");
  els.updatePanel.hidden = mode !== "update";
  els.recoveryPanel.hidden = mode !== "recovery";
  if (mode === "update") {
    els.modeHint.textContent =
      "Writes the app (and the GUI if you add it) plus a fresh boot table, as separate " +
      "segments. Keeps calibration and WiFi. Use this for normal updates.";
    els.modeCallout.className = "callout ok";
    els.modeCallout.innerHTML =
      "<span class='ic'>🛡️</span><span>Calibration and WiFi are <strong>preserved</strong> - " +
      "the nvs partition at 0x9000 is never touched.</span>";
  } else {
    els.modeHint.textContent =
      "Writes one merged image over the whole flash. Rebuilds everything and ERASES " +
      "calibration and WiFi. Only for a bricked or fresh unit.";
    els.modeCallout.className = "callout warn";
    els.modeCallout.innerHTML =
      "<span class='ic'>⚠️</span><span>Recovery <strong>erases</strong> calibration and WiFi " +
      "(the nvs partition). Only use it on a bricked or fresh unit.</span>";
  }
  updateFlashEnabled();
}

// Bind a file input to a state setter and its filename label.
function bindFileInput(inputEl, nameEl, setter) {
  inputEl.addEventListener("change", (e) => {
    const f = e.target.files[0] || null;
    setter(f);
    nameEl.textContent = f ? `${f.name} (${(f.size / 1024).toFixed(1)} KB)` : "no file";
    nameEl.classList.toggle("set", !!f);
    updateFlashEnabled();
  });
}

// ---------------------------------------------------------------------------
// Connect the flash port / device info
// ---------------------------------------------------------------------------
async function connect() {
  if (flashing) return;
  if (connected) await hardCleanup();   // "Reconnect": drop the old port first
  let chosen;
  try {
    chosen = await navigator.serial.requestPort();
  } catch (e) {
    logLine("No port selected.", "warn");
    return;
  }
  // If the log monitor is already open on this same device, gently close it so we
  // can flash on it. A different device is left alone (flash + log can coexist).
  if (logOpen && chosen === logPort) {
    logLine("This port is open in the log monitor - closing the monitor so it can flash.", "dim");
    await closeLogs();
  }
  port = chosen;

  // Auto-reset into the bootloader, no button press. esptool-js picks the reset by
  // USB PID: a native USB-Serial-JTAG board (PID 0x1001) gets the USB-JTAG reset,
  // anything else gets the classic DTR/RTS auto-reset - same as esptool.py's
  // default-reset. We try a small ladder so custom boards work too.
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
    logLine("Auto-reset did not work. If this is a custom board with no auto-reset circuit, hold BOOT while clicking Connect (release after the port picker). Also close any other program using the port and use a data USB cable.", "warn");
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

// Reset the flash-connected board into the app, then end the flash session.
async function resetBoard() {
  if (flashing || !port) return;
  logLine("Resetting board (RTS pulse)...", "dim");
  try {
    await pulseResetPort(port);
  } catch (e) {
    logLine("Reset failed: " + (e.message || e), "err");
    return;
  }
  logLine("Board reset - it should be running the app now. Open the Logs monitor to watch it.", "ok");
  await hardCleanup();
  setStatus("Reset", "");
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

const hex = (n) => "0x" + n.toString(16);

// Build the list of {data, address} segments to write, and validate them, per mode.
// Recovery: one merged image at 0x0. Update: separate segments that skip nvs (0x9000).
async function buildFileArray() {
  if (flashMode === "recovery") {
    const data = new Uint8Array(await localFile.arrayBuffer());
    if (data.length === 0) throw new Error("The firmware file is empty.");
    if (data[0] !== 0xe9) {
      logLine("Warning: merged image does not start with 0xE9 (ESP image magic). Is this a full image for offset 0?", "warn");
    }
    return [{ data, address: FLASH_OFFSET, name: "merged image" }];
  }
  // Update mode: blank ota_data (0xf000), app (0x20000), optional www (0x830000).
  const app = new Uint8Array(await appImg.arrayBuffer());
  if (app.length === 0) throw new Error("The app file is empty.");
  if (app[0] !== 0xe9) {
    throw new Error("App image does not start with 0xE9 (ESP image magic). Is this exoskeleton_main_firmware.bin?");
  }
  // Blank (all-0xFF) ota_data. With no factory partition, a blank boot selector makes
  // the bootloader boot ota_0 - so the unit runs the app we just wrote, whatever slot
  // it ran before. Generated in-browser; no ota_data file is needed.
  const blankOta = new Uint8Array(OTADATA_SIZE).fill(0xff);
  const arr = [
    { data: blankOta, address: OTADATA_OFFSET, name: "ota_data (blank, generated)" },   // 0xf000 - boots ota_0
    { data: app, address: APP_OFFSET, name: "app" },                                    // 0x20000
  ];
  if (wwwImg) {
    const www = new Uint8Array(await wwwImg.arrayBuffer());
    if (www.length > 0) arr.push({ data: www, address: WWW_OFFSET, name: "www (GUI)" });   // 0x830000
  }
  return arr;
}

async function flash() {
  if (!connected || flashing) return;
  if (flashMode === "recovery" && !localFile) return;
  if (flashMode === "update" && !appImg) return;

  if (flashMode === "recovery" &&
      !window.confirm("Recovery mode writes a full image and ERASES calibration and WiFi " +
        "(the nvs partition). Only use it on a bricked or fresh unit.\n\nContinue?")) {
    return;
  }

  flashing = true;
  els.flashBtn.disabled = true;
  els.progressWrap.hidden = false;
  els.progressBar.classList.remove("done", "failed");   // reset any finished state
  setStatus("Flashing", "busy");
  setProgress(0, "Reading firmware");

  try {
    const fileArray = await buildFileArray();
    const sizes = fileArray.map((f) => f.data.length);
    const totalAll = sizes.reduce((a, b) => a + b, 0) || 1;

    if (flashMode === "recovery") {
      logLine("Recovery mode - writing one merged image at 0x0 (this erases nvs / calibration):", "warn");
    } else {
      logLine("Update mode - writing segments, nvs at 0x9000 left untouched:", "dim");
    }
    fileArray.forEach((f) => logLine(`  ${hex(f.address).padEnd(9)} ${(f.data.length / 1024).toFixed(1).padStart(7)} KB  ${f.name}`, "dim"));
    setProgress(0, "Erasing and writing");

    await esploader.writeFlash({
      fileArray,
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (i, written, total) => {
        const frac = total ? written / total : 0;
        const before = sizes.slice(0, i).reduce((a, b) => a + b, 0);
        setProgress((before + sizes[i] * frac) / totalAll,
          `Writing ${i + 1}/${fileArray.length} at ${hex(fileArray[i].address)}`);
      },
    });

    setProgress(1, "Flash complete");
    els.progressBar.classList.add("done");   // stop the moving stripes, show a solid bar
    setStatus("Flashed OK", "ok");
    logLine("Flash complete. Resetting into the new firmware and starting the log...", "ok");
    flashing = false;                 // done writing; the auto-reset/log step follows
    try { await autoResetAndLog(); } catch (e2) { logLine("Auto reset/log note: " + (e2.message || e2), "dim"); }
  } catch (e) {
    logLine("Flash failed: " + (e.message || e), "err");
    setStatus("Flash failed", "err");
    setProgress(0, "Failed");
    els.progressBar.classList.add("failed");
  } finally {
    flashing = false;
    updateFlashEnabled();
  }
}

// After a successful flash: reset the board into the new firmware and start the
// log automatically. If a separate monitor is already open on another port, just
// reset (that monitor shows the reboot). Otherwise move the flash port into the
// log monitor, reset, and stream the boot log.
async function autoResetAndLog() {
  const flashPort = port;
  if (!flashPort) return;
  if (logOpen && logPort && logPort !== flashPort) {
    logLine("Resetting into the new firmware...", "dim");
    try { await pulseResetPort(flashPort); } catch (e) { logLine("Reset note: " + (e.message || e), "dim"); }
    await hardCleanup();
    setStatus("Flashed - running", "ok");
    return;
  }
  await beginLog(flashPort, true);
  setStatus("Flashed - logging", "ok");
}

// ---------------------------------------------------------------------------
// Logs & console - independent serial monitor
// ---------------------------------------------------------------------------
async function openLogs() {
  if (logOpen) return;
  let chosen;
  try {
    chosen = await navigator.serial.requestPort();
  } catch (e) {
    logLine("No log port selected.", "warn");
    return;
  }
  await beginLog(chosen, false);   // manual open: just watch, do not reset
}

// Open a serial port as the log monitor. If the flash connection holds this same
// device, release it first. With reset=true, pulse the board into the app after the
// reader is up. The console shares the flashing USB and re-enumerates on reset, so the
// read loop tolerates the drop and the port is reopened automatically.
async function beginLog(p, reset) {
  if (port && p === port) {
    logLine("Using the flashing port for logs - closing the flash connection first.", "dim");
    await hardCleanup();   // closes the port; p stays a valid SerialPort to reopen
  }
  logBaudRate = parseInt(els.logBaud.value, 10) || 115200;
  logOpen = true;
  els.logOpenBtn.textContent = "Close";
  els.logResetBtn.hidden = false;
  els.logBaud.disabled = true;
  if (!(await attachLogPort(p))) { await closeLogs(); return false; }
  logLine(`--- log monitor open (${logBaudRate} baud) - watching for '${IMU_OK}' ---`, "dim");
  if (reset) {
    await sleep(80);
    logLine("Resetting into the app...", "dim");
    // pulse resets the chip; the USB re-enumerates and the monitor reopens itself
    try { await pulseResetPort(logPort); } catch (e) { logLine("Reset note: " + (e.message || e), "dim"); }
  }
  return true;
}

// Open a specific SerialPort at the monitor baud and read it in the background.
async function attachLogPort(p) {
  logPort = p;
  try {
    await logPort.open({ baudRate: logBaudRate });
  } catch (e) {
    logLine("Could not open the log port: " + (e.message || e) +
      " - another program may be using it (idf.py monitor, Arduino IDE, PuTTY).", "err");
    logPort = null;
    return false;
  }
  logReconnecting = false;
  els.logReconnectBtn.hidden = true;
  readLogLoop();   // background; returns when the port drops or the monitor closes
  return true;
}

async function closeLogs() {
  logOpen = false;
  logReconnecting = false;
  els.logOpenBtn.textContent = "Open";
  els.logResetBtn.hidden = true;
  els.logReconnectBtn.hidden = true;
  els.logBaud.disabled = false;
  try { if (logReader) await logReader.cancel(); } catch (e) {}
  try { if (logPort) await logPort.close(); } catch (e) {}
  logReader = null;
  logPort = null;
  logLine("--- log monitor closed ---", "dim");
}

// Read logPort until it drops (a reboot re-enumeration) or the monitor is closed.
// On a drop, hand off to enterReconnectWait so the port is reopened when the board
// comes back.
async function readLogLoop() {
  const decoder = new TextDecoder();
  let buffer = "";
  while (logOpen && logPort && logPort.readable) {
    let reader;
    try {
      reader = logPort.readable.getReader();
      logReader = reader;
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
      break;   // dropped (usually the reboot re-enumeration)
    } finally {
      try { reader && reader.releaseLock(); } catch (e) {}
      logReader = null;
    }
    if (!logOpen) break;
  }
  try { if (logPort) await logPort.close(); } catch (e) {}
  if (logOpen && !logReconnecting) enterReconnectWait();
}

// True if a port looks like our ESP32-S3 native USB-Serial-JTAG.
function boardLike(p) {
  const i = p && p.getInfo ? p.getInfo() : {};
  return i.usbVendorId === BOARD_VID && i.usbProductId === BOARD_JTAG_PID;
}

// The board dropped off USB on reset. Wait for it to re-enumerate and reopen it. The
// 'connect' event (onSerialConnect) is the primary trigger; we also poll getPorts as a
// fallback, and show a one-click "Reconnect monitor" button.
function enterReconnectWait() {
  logReconnecting = true;
  els.logReconnectBtn.hidden = false;
  logLine("Board dropped off USB (reboot) - waiting for it to come back...", "dim");
  pollReopen();
}

async function pollReopen() {
  for (let i = 0; i < 120 && logOpen && logReconnecting; i++) {
    await sleep(150);   // ~18s window
    try {
      const ports = await navigator.serial.getPorts();
      const match = ports.find(boardLike) || (logPort && ports.indexOf(logPort) >= 0 ? logPort : null);
      if (match) { await resumeLog(match); return; }
    } catch (e) { /* keep waiting */ }
  }
}

// Reopen the monitor on a returning port and resume streaming.
async function resumeLog(p) {
  if (!logOpen || !logReconnecting || !p) return;
  logReconnecting = false;              // claim the reconnect (guards against double calls)
  logLine("(reconnected)", "dim");
  if (!(await attachLogPort(p))) {
    logReconnecting = true;
    els.logReconnectBtn.hidden = false;
  }
}

// Manual fallback: let the user pick the returning port and resume on it.
async function manualReconnect() {
  if (!logOpen) return;
  let p;
  try { p = await navigator.serial.requestPort(); }
  catch (e) { logLine("No port selected.", "warn"); return; }
  logReconnecting = true;
  await resumeLog(p);
}

// Save the console to a .txt file the user can download.
function saveLog() {
  const text = els.console.textContent;
  if (!text.trim()) { logLine("Nothing to save yet.", "warn"); return; }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `exo-log-${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// When the monitored board drops off USB (reset), cancel the current read so the read
// loop unblocks and moves into the reconnect wait.
function onSerialDisconnect(e) {
  const p = e.target || e.port;
  if (logOpen && logPort && p === logPort) {
    try { if (logReader) logReader.cancel(); } catch (err) {}
  }
}

// When a previously-authorized port re-appears and we are waiting to reconnect, resume
// the monitor on it if it is our board (or the same port handle).
function onSerialConnect(e) {
  const p = e.target || e.port;
  if (logOpen && logReconnecting && p && (p === logPort || boardLike(p))) resumeLog(p);
}

// Reboot the board we are monitoring (RTS pulse on the log port), keep streaming.
async function resetLogs() {
  if (!logOpen || !logPort) return;
  logLine("Resetting monitored board (RTS pulse)...", "dim");
  try { await pulseResetPort(logPort); } catch (e) { logLine("Reset failed: " + (e.message || e), "err"); }
}

// ---------------------------------------------------------------------------
// Disconnect / cleanup (flash port only; the log monitor is independent)
// ---------------------------------------------------------------------------
async function disconnect() {
  await hardCleanup();
  setStatus("Disconnected", "");
  logLine("Disconnected.", "dim");
}

async function hardCleanup() {
  try { if (transport) await transport.disconnect(); } catch (e) {}
  try { if (port) await port.close(); } catch (e) {}
  connected = false;
  esploader = null;
  transport = null;
  port = null;
  els.deviceInfo.hidden = true;
  els.disconnectBtn.hidden = true;
  els.resetBtn.hidden = true;
  els.connectBtn.textContent = "Connect";
  els.flashBtn.textContent = "Flash";
  updateFlashEnabled();
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

  els.modeUpdate.addEventListener("click", () => setMode("update"));
  els.modeRecovery.addEventListener("click", () => setMode("recovery"));
  bindFileInput(els.appFile, els.appFileName, (f) => (appImg = f));
  bindFileInput(els.wwwFile, els.wwwFileName, (f) => (wwwImg = f));

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

  els.logOpenBtn.addEventListener("click", () => (logOpen ? closeLogs() : openLogs()));
  els.logResetBtn.addEventListener("click", resetLogs);
  els.logReconnectBtn.addEventListener("click", manualReconnect);
  navigator.serial.addEventListener("disconnect", onSerialDisconnect);
  navigator.serial.addEventListener("connect", onSerialConnect);
  els.clearLogBtn.addEventListener("click", () => { els.console.textContent = ""; });
  els.copyLogBtn.addEventListener("click", () => navigator.clipboard.writeText(els.console.textContent));
  els.saveLogBtn.addEventListener("click", saveLog);

  window.addEventListener("beforeunload", () => {
    try { hardCleanup(); } catch (e) {}
    try { closeLogs(); } catch (e) {}
  });

  setMode("update");
  setStatus("Disconnected", "");
}

init();
