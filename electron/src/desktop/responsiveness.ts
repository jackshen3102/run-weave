import { app, BrowserWindow, powerMonitor } from "electron";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { responsivenessProbe } from "./responsiveness-probe.js";

let observer: Worker | null = null;

function record(event: string, details: unknown, samplePid?: number): void {
  observer?.postMessage({ event, details, samplePid });
}

export function startDesktopResponsivenessMonitor(
  logsDir: string,
  launchId: string,
): void {
  if (observer) return;
  const heartbeat = new SharedArrayBuffer(8);
  const state = new Int32Array(heartbeat);
  const worker = new Worker(path.join(__dirname, "responsiveness-worker.cjs"), {
    workerData: {
      directory: path.join(logsDir, "responsiveness"),
      launchId,
      mainPid: process.pid,
      heartbeat,
    },
  });
  observer = worker;
  worker.unref();
  const timer = setInterval(() => Atomics.add(state, 0, 1), 1_000);
  timer.unref();
  const suspend = () => {
    Atomics.store(state, 1, 1);
    record("system.suspend", {});
  };
  const resume = () => {
    Atomics.add(state, 0, 1);
    Atomics.store(state, 1, 0);
    record("system.resume", {});
  };
  powerMonitor.on("suspend", suspend);
  powerMonitor.on("resume", resume);
  const cleanup = () => {
    clearInterval(timer);
    powerMonitor.off("suspend", suspend);
    powerMonitor.off("resume", resume);
    if (observer === worker) observer = null;
  };
  worker.on("error", (error) => {
    cleanup();
    console.warn("[electron] responsiveness observer unavailable", error);
  });
  worker.once("exit", cleanup);
  app.once("will-quit", () => {
    cleanup();
    void worker.terminate();
  });
}

export function watchDesktopWindow(win: BrowserWindow): void {
  if (!observer) return;
  const contents = win.webContents;
  let nativeKeys = 0;
  let nativeClicks = 0;
  let pending = false;
  let generation = 0;
  let latest: unknown = null;
  let previous = "";
  let lastRecorded = 0;
  let lastProbe = -Infinity;
  let inputTimer: NodeJS.Timeout | null = null;
  const scheduleInputProbe = () => {
    if (inputTimer || performance.now() - lastProbe < 2_000) return;
    inputTimer = setTimeout(() => {
      inputTimer = null;
      poll();
    }, 200);
  };
  const snapshot = () => ({
    windowId: win.id,
    rendererPid: contents.getOSProcessId(),
    focused: win.isFocused(),
    visible: win.isVisible(),
    minimized: win.isMinimized(),
    enabled: win.isEnabled(),
    focusable: win.isFocusable(),
    focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null,
    focusedWebContentsId: contents.isFocused() ? contents.id : null,
    childWindows: win
      .getChildWindows()
      .map((child) => ({
        id: child.id,
        modal: child.isModal(),
        visible: child.isVisible(),
      })),
    nativeKeys,
    nativeClicks,
    renderer: latest,
  });
  const sampleRenderer = (event: string) =>
    record(event, snapshot(), contents.getOSProcessId());
  contents.on("before-input-event", () => {
    nativeKeys += 1;
    scheduleInputProbe();
  });
  contents.on("before-mouse-event", (_event, input) => {
    if (input.type === "mouseDown") {
      nativeClicks += 1;
      scheduleInputProbe();
    }
  });
  win.on("focus", () => record("window.focus", snapshot()));
  win.on("blur", () => record("window.blur", snapshot()));
  win.on("show", () => record("window.show", snapshot()));
  win.on("hide", () => record("window.hide", snapshot()));
  win.on("minimize", () => record("window.minimize", snapshot()));
  win.on("restore", () => record("window.restore", snapshot()));
  win.on("unresponsive", () => sampleRenderer("renderer.unresponsive"));
  win.on("responsive", () => record("renderer.responsive", snapshot()));
  contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) {
      generation += 1;
      pending = false;
      latest = null;
    }
  });
  const poll = () => {
    if (
      pending ||
      win.isDestroyed() ||
      contents.isDestroyed() ||
      !win.isVisible() ||
      win.isMinimized() ||
      contents.isLoadingMainFrame()
    )
      return;
    pending = true;
    lastProbe = performance.now();
    const current = generation;
    const started = performance.now();
    let timedOut = false;
    const timeout = setTimeout(() => {
      if (current !== generation || win.isDestroyed()) return;
      timedOut = true;
      sampleRenderer("renderer.probeTimeout");
    }, 5_000);
    // A single in-flight probe prevents a hung renderer from accumulating requests.
    void contents
      .executeJavaScriptInIsolatedWorld(1002, [{ code: responsivenessProbe }])
      .then((value: unknown) => {
        if (current !== generation || win.isDestroyed()) return;
        latest = value;
        const serialized = JSON.stringify(value);
        if (
          timedOut ||
          serialized !== previous ||
          Date.now() - lastRecorded >= 30_000
        ) {
          record(timedOut ? "renderer.probeRecovered" : "window.state", {
            ...snapshot(),
            probeDurationMs: Math.round(performance.now() - started),
          });
          previous = serialized;
          lastRecorded = Date.now();
        }
      })
      .catch(() => {
        if (current === generation && !win.isDestroyed())
          record("renderer.probeFailed", snapshot());
      })
      .finally(() => {
        clearTimeout(timeout);
        if (current === generation) pending = false;
      });
  };
  const timer = setInterval(poll, 10_000);
  timer.unref();
  win.once("closed", () => {
    generation += 1;
    clearInterval(timer);
    if (inputTimer) clearTimeout(inputTimer);
    record("window.closed", { windowId: win.id });
  });
}
