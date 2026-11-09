import { BrowserWindow, desktopCapturer, ipcMain, systemPreferences } from "electron";
import { createWindow } from "../../desktop/window.js";
import { trustedBrowserWindow } from "../security/sender.js";
import { SimulatorObserver } from "./simulators.js";

const observers = new Map<number, BrowserWindow>();
const simulators = new Map<number, SimulatorObserver>();
export function automationOwner(window: BrowserWindow): number {
  for (const [owner, observer] of observers) if (observer === window) return owner;
  return window.id;
}
export function automationObserver(owner: number): BrowserWindow | undefined {
  return observers.get(owner);
}
export function registerAutomationObserver(): void {
  ipcMain.handle("automation:open-window", (event) => {
    const owner = trustedBrowserWindow(event);
    if (!owner) throw new Error("Invalid observation window source");
    const ownerId = automationOwner(owner);
    const existing = observers.get(ownerId);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show(); existing.focus(); return;
    }
    const observer = createWindow({ initialPath: "/agent-observer" });
    observers.set(ownerId, observer);
    const simulator = new SimulatorObserver();
    simulators.set(observer.id, simulator);
    const close = () => { if (!observer.isDestroyed()) observer.close(); };
    owner.once("closed", close);
    observer.once("closed", () => { simulator.close(); simulators.delete(observer.id); observers.delete(ownerId); owner.removeListener("closed", close); });
  });
  ipcMain.handle("automation:open-terminal", (event, source: unknown) => {
    const viewer = trustedBrowserWindow(event);
    const target = source as { connectionId?: unknown; terminalSessionId?: unknown } | null;
    if (!viewer || automationOwner(viewer) === viewer.id || !target ||
      typeof target.connectionId !== "string" || typeof target.terminalSessionId !== "string" ||
      target.connectionId.length > 512 || target.terminalSessionId.length > 512) throw new Error("Invalid terminal source");
    const owner = BrowserWindow.fromId(automationOwner(viewer));
    if (!owner || owner.isDestroyed()) throw new Error("Source window closed");
    owner.webContents.send("automation:open-terminal", target);
    if (owner.isMinimized()) owner.restore();
    owner.show(); owner.focus();
  });
  let capturing = false;
  ipcMain.handle("automation:simulators", (event, continuous: unknown) => {
    const viewer = trustedBrowserWindow(event);
    const simulator = viewer && simulators.get(viewer.id);
    if (!simulator || !Array.isArray(continuous) || continuous.length > 6 ||
      continuous.some(id => typeof id !== "string" || !/^simulator:[a-f0-9]{32}$/.test(id)))
      throw new Error("Invalid simulator observation request");
    return simulator.poll(continuous);
  });
  ipcMain.handle("automation:windows", async (event, selected: unknown) => {
    const window = trustedBrowserWindow(event);
    if (!window || automationOwner(window) === window.id) throw new Error("Observation window required");
    if (!Array.isArray(selected) || selected.length > 6 || selected.some(id => typeof id !== "string"))
      throw new Error("Select at most six windows");
    if (capturing) throw new Error("Window capture is busy");
    if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("screen") === "denied")
      throw new Error("请在系统设置中允许 Runweave 录制屏幕，再重新打开观察窗口");
    capturing = true;
    try {
      const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: selected.length ? { width: 960, height: 600 } : { width: 0, height: 0 } });
      return sources.filter(source => source.id !== window.getMediaSourceId()).map(source => ({
        id: source.id, name: source.name,
        image: selected.includes(source.id) && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : null,
        capturedAt: Date.now(),
      }));
    } finally { capturing = false; }
  });
}
