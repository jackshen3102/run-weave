import { execFile, fork } from "node:child_process";
import path from "node:path";
import {
  ProgramStatusStream, resolveProgramStatus, updateProgramStatusRecords,
  type ProgramStatusReport, type TerminalProgramStatus,
} from "@runweave/shared/terminal/program-status";

type HostProgramStatus = Omit<TerminalProgramStatus, "source">;
type ConsoleOwner = { pid: number; startTicks: string };

/** Use node-pty's console enumeration in a child so AttachConsole cannot affect the Host. */
async function findConsoleCodex(helper: string, shellPid: number): Promise<ConsoleOwner | undefined> {
  if (!shellPid) return;
  const pids = await new Promise<number[]>(resolve => {
    const worker = fork(helper, [String(shellPid)], { silent: true });
    const timer = setTimeout(() => worker.kill(), 750).unref();
    worker.once("message", (message: { consoleProcessList?: number[] }) => {
      resolve(message.consoleProcessList?.filter(pid => Number.isSafeInteger(pid) && pid > 0) ?? []);
    });
    worker.once("error", () => resolve([]));
    worker.once("exit", () => { clearTimeout(timer); resolve([]); });
  });
  if (!pids.length) return;
  const identities = await new Promise<string>(resolve => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | Where-Object ProcessName -eq 'codex' | ForEach-Object { '{0}:{1}' -f $_.Id,$_.StartTime.ToUniversalTime().Ticks }`,
    ], { timeout: 900, windowsHide: true }, (_error, stdout) => resolve(stdout.trim()));
  });
  // Multiple attached Codex processes leave ownership ambiguous.
  const match = /^(\d+):(\d+)$/.exec(identities);
  if (match) return { pid: Number(match[1]), startTicks: match[2]! };
}

export class HostProgramStatusStream {
  private readonly stream = new ProgramStatusStream();
  private readonly records = new Map<string, ProgramStatusReport>();
  private readonly pending: { report: ProgramStatusReport; observedAt: string }[] = [];
  private owner?: ConsoleOwner;
  private probe?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private active = true;
  private status?: HostProgramStatus;

  constructor(nodePtyEntry: string, private readonly pid: () => number,
    private readonly update: (status?: HostProgramStatus) => void) {
    this.helper = path.join(path.dirname(nodePtyEntry), "conpty_console_list_agent.js");
  }

  private readonly helper: string;

  write(data: string): string {
    const observedAt = new Date().toISOString();
    const output = this.stream.write(data, report => {
      if (this.pending.length >= 256) this.pending.shift();
      this.pending.push({ report, observedAt });
    });
    if (this.pending.length) this.observe();
    return output;
  }

  private observe(): void {
    if (this.probe || !this.active) return;
    const batch = this.pending.splice(0);
    this.probe = findConsoleCodex(this.helper, this.pid()).catch(() => undefined).then(owner => {
      if (!this.active) return;
      if (owner?.pid !== this.owner?.pid || owner?.startTicks !== this.owner?.startTicks) {
        this.owner = owner;
        this.records.clear();
        this.publish();
      }
      if (!owner) {
        clearInterval(this.timer);
        this.timer = undefined;
        return;
      }
      for (const { report, observedAt } of batch) {
        updateProgramStatusRecords(this.records, report);
        const next = resolveProgramStatus(this.records);
        this.publish(next && { ...next, observedAt }, true);
      }
      this.timer ??= setInterval(() => {
        const current = this.owner;
        if (!current || this.probe) return;
        try {
          process.kill(current.pid, 0);
        } catch {
          this.owner = undefined;
          this.records.clear();
          this.publish();
          clearInterval(this.timer);
          this.timer = undefined;
        }
      }, 500).unref();
    }).finally(() => {
      this.probe = undefined;
      if (this.pending.length) this.observe();
    });
  }

  private publish(status?: HostProgramStatus, live = false): void {
    if (!this.status && !status) return;
    if (!live && this.status?.state === status?.state && this.status?.kind === status?.kind) return;
    this.status = status;
    this.update(status);
  }

  dispose(): void {
    this.active = false;
    clearInterval(this.timer);
    this.pending.length = 0;
    this.publish();
  }
}
