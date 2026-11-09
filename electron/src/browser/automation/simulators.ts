import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { nativeImage } from "electron";
import type { AgentObserverSimulatorFrame } from "@runweave/shared/terminal-browser-automation";

const exec = promisify(execFile);
const base = join(homedir(), ".runweave");
interface Observation {
  schemaVersion: number; udid: string; lease: string; taskDir: string; app: string;
  terminalSessionId: string | null; operationId: string; action: string;
  phase: "running" | "settling" | "private"; expiresAt: number; settleUntil?: number;
}
async function observation(udid: string): Promise<Observation | null> {
  try {
    const [state, owner] = await Promise.all([
      readFile(join(base, "agent-device", "observations", `${udid}.json`), "utf8").then(JSON.parse),
      readFile(join(base, "native-device", "locks", udid, "owner.json"), "utf8").then(JSON.parse),
    ]);
    if (state.schemaVersion !== 1 || state.udid !== udid || owner.kind !== "simulator-pool" ||
      owner.lease !== state.lease || owner.taskDir !== state.taskDir || owner.finishedAt ||
      typeof state.operationId !== "string" || !["running", "settling", "private"].includes(state.phase) ||
      typeof state.expiresAt !== "number" || !/^[a-z-]{1,24}$/.test(state.action)) return null;
    return state;
  } catch { return null; }
}
function phase(state: Observation): AgentObserverSimulatorFrame["phase"] {
  if (state.phase === "private") return "private";
  if (state.expiresAt < Date.now() || (state.phase === "settling" && (state.settleUntil ?? 0) < Date.now())) return "idle";
  return state.phase;
}
async function screenshot(udid: string): Promise<Buffer> {
  // Some Xcode versions document stdout support but treat '-' as a filename.
  const directory = await mkdtemp(join(tmpdir(), "runweave-observer-"));
  try {
    const path = join(directory, "frame.jpg");
    await exec("/usr/bin/xcrun", ["simctl", "io", udid, "screenshot", "--type=jpeg", path], { timeout: 5000 });
    return await readFile(path);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Viewer lifetime only. Closing the observer never owns or stops device operations. */
export class SimulatorObserver {
  private frames = new Map<string, AgentObserverSimulatorFrame>();
  private pending: Promise<AgentObserverSimulatorFrame[]> | null = null;
  private closed = false;
  close(): void { this.closed = true; this.frames.clear(); }
  poll(continuous: string[]): Promise<AgentObserverSimulatorFrame[]> {
    if (!this.pending) this.pending = this.read(continuous).finally(() => { this.pending = null; });
    return this.pending;
  }
  private async read(continuous: string[]): Promise<AgentObserverSimulatorFrame[]> {
    if (this.closed || process.platform !== "darwin") return [];
    const names = await readdir(join(base, "agent-device", "observations")).catch(() => [] as string[]);
    const states = (await Promise.all(names.filter(name => /^[A-F0-9-]{36}\.json$/.test(name))
      .map(name => observation(name.slice(0, -5))))).filter((item): item is Observation => item !== null);
    const live = new Set(states.map(state => `simulator:${state.lease}`));
    for (const id of this.frames.keys()) if (!live.has(id)) this.frames.delete(id);
    await Promise.all(states.map(state => this.update(state, continuous)));
    return this.closed ? [] : [...this.frames.values()];
  }
  private async update(state: Observation, continuous: string[]): Promise<void> {
    const id = `simulator:${state.lease}`;
    const previous = this.frames.get(id);
    const currentPhase = phase(state);
    const frame: AgentObserverSimulatorFrame = {
      id, name: `${state.app} · iOS 模拟器`, udid: state.udid,
      terminalSessionId: typeof state.terminalSessionId === "string" ? state.terminalSessionId : null,
      phase: currentPhase, action: state.action, error: null,
      image: currentPhase === "private" ? null : previous?.image ?? null,
      capturedAt: currentPhase === "private" ? 0 : previous?.capturedAt ?? 0,
    };
    if (currentPhase !== "private" && (currentPhase !== "idle" || continuous.includes(id)) &&
      Date.now() - frame.capturedAt >= 900 && !this.closed) {
      try {
        const bytes = await screenshot(state.udid);
        const latest = await observation(state.udid);
        // Discard frames raced by a private command, device release, or a new operation.
        if (!latest || latest.operationId !== state.operationId || latest.phase === "private" || this.closed) return;
        const picture = nativeImage.createFromBuffer(bytes);
        if (picture.isEmpty()) throw new Error("Empty simulator frame");
        frame.image = `data:image/jpeg;base64,${picture.resize({ height: 800 }).toJPEG(75).toString("base64")}`;
        frame.capturedAt = Date.now();
      } catch { frame.error = "模拟器画面暂不可用"; }
    }
    if (!this.closed) this.frames.set(id, frame);
  }
}
