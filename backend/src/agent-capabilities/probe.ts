import { spawn } from "node:child_process";
import type { AgentCapabilityReason } from "@runweave/shared/agent-capabilities";

const TIMEOUT_MS = 3_000;
const MAX_OUTPUT_BYTES = 16 * 1_024;
interface ProbeResult { stdout: string; reason: AgentCapabilityReason | null }

/** Owns only read-only CLI probes, not terminals or native login state. */
export class AgentCapabilityProbe {
  private closed = false;
  private cleanupFailed = false;
  private readonly pending = new Map<() => void, Promise<ProbeResult>>();

  run(binary: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<ProbeResult> {
    if (this.closed) return Promise.resolve({ stdout: "", reason: "service_closed" });
    let cancel = () => {};
    const result = new Promise<ProbeResult>((resolve) => {
      let stdout = "";
      let bytes = 0;
      let failure: AgentCapabilityReason | null = null;
      let finished = false;
      let exited = false;
      // No shell; a private process group lets the timeout kill inherited pipes
      // too on POSIX. Windows native executables are killed directly.
      const child = spawn(binary, args, {
        env, cwd, shell: false, windowsHide: true,
        detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      });
      const finish = (reason: AgentCapabilityReason | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        clearTimeout(killDeadline);
        resolve({ stdout: reason && reason !== "probe_failed" ? "" : stdout, reason });
      };
      const stop = (reason: AgentCapabilityReason) => {
        if (finished || failure) return;
        failure = reason;
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch { child.kill("SIGKILL"); }
        // Bound even a broken wrapper/descendant retaining a pipe. Destroying
        // readers never turns a timeout into a successful probe.
        killDeadline = setTimeout(() => {
          if (!exited) this.cleanupFailed = true;
          child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(reason);
        }, 500);
      };
      let killDeadline: ReturnType<typeof setTimeout> | undefined;
      const timeout = setTimeout(() => stop("probe_timeout"), TIMEOUT_MS);
      cancel = () => stop("service_closed");
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) stop("probe_output_limit");
        else stdout += chunk.toString("utf8");
      });
      // Auth output may contain account identifiers. Count but never retain stderr.
      child.stderr.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) stop("probe_output_limit");
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        finish(failure ?? (error.code === "ENOENT" ? "cli_missing" : "probe_failed"));
      });
      child.once("exit", () => { exited = true; });
      child.once("close", (code) => finish(failure ?? (code === 0 ? null : "probe_failed")));
    }).catch((): ProbeResult => ({ stdout: "", reason: "probe_failed" }));
    this.pending.set(cancel, result);
    void result.then(() => this.pending.delete(cancel));
    return result;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    for (const cancel of this.pending.keys()) cancel();
    await Promise.all(this.pending.values());
    if (this.cleanupFailed) throw new Error("agent_capability_probe_cleanup_unconfirmed");
  }
}
