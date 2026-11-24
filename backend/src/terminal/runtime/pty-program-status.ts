import { execFileSync } from "node:child_process";
import path from "node:path";
import { ProgramStatusStream, resolveProgramStatus, updateProgramStatusRecords, type ProgramStatusReport } from "@runweave/shared/terminal/program-status";
import type { TerminalSessionManager } from "../manager/manager";
import type { PtyRuntime } from "./pty-service";

/** Only the native foreground Codex, on this particular PTY, owns its reports. */
function findForegroundCodex(tty: string): string | undefined {
  const rows = execFileSync("ps", ["-t", tty, "-o", "pid=,pgid=,tpgid=,lstart=,comm="], {
    encoding: "utf8", timeout: 250, env: { LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"],
  });
  for (const row of rows.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/.exec(row);
    if (match && match[2] === match[3] && path.basename(match[5]!) === "codex") {
      return `${match[1]}:${match[4]}`;
    }
  }
}

export function createPtyProgramStatus(manager: TerminalSessionManager, sessionId: string, runtime: PtyRuntime) {
  const stream = new ProgramStatusStream();
  const records = new Map<string, ProgramStatusReport>();
  let shellPid: number | undefined;
  let tty: string | undefined;
  let owner: string | undefined;
  let timer: NodeJS.Timeout | undefined;

  function currentOwner(): string | undefined {
    if (process.platform === "win32") return undefined;
    try {
      if (shellPid !== runtime.pid || !tty) {
        shellPid = runtime.pid;
        tty = execFileSync("ps", ["-p", String(shellPid), "-o", "tty="], {
          encoding: "utf8", timeout: 250, stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      }
      return tty ? findForegroundCodex(tty) : undefined;
    } catch {
      return undefined;
    }
  }

  function clear() {
    clearInterval(timer);
    timer = undefined;
    owner = undefined;
    records.clear();
    manager.setSessionProgramStatus(sessionId);
  }

  return {
    write(data: string) {
      const reports: ProgramStatusReport[] = [];
      const output = stream.write(data, report => reports.push(report));
      if (reports.length === 0) return output;
      const current = currentOwner();
      if (current !== owner) clear();
      if (!current) return output;
      owner = current;
      timer ??= setInterval(() => {
        if (currentOwner() !== owner) clear();
      }, 500).unref();
      if (!manager.getSession(sessionId)?.oscProgramStatus) records.clear();
      for (const report of reports) {
        updateProgramStatusRecords(records, report);
        manager.setSessionProgramStatus(sessionId, resolveProgramStatus(records));
      }
      return output;
    },
    dispose: clear,
  };
}
