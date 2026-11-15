import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
export interface OwnedTerminalProcess {
  pid: number;
  parent: number;
  identity: string;
}

async function processes(): Promise<OwnedTerminalProcess[]> {
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,uid=,lstart="], {
    timeout: 3_000, maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/);
    return match && Number(match[3]) === process.getuid?.()
      ? [{ pid: Number(match[1]), parent: Number(match[2]), identity: `${match[3]}:${match[4]}` }] : [];
  });
}

/** Only descendants of this run's private pane, never a shared executor/host. */
export async function terminalChildren(panePid: number): Promise<OwnedTerminalProcess[]> {
  const rows = await processes();
  if (!rows.some(row => row.pid === panePid)) throw new Error("provider_stop_unconfirmed");
  const owned = new Set([panePid]);
  for (let pass = 0; pass < rows.length; pass++) {
    const before = owned.size;
    for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid);
    if (owned.size === before) break;
  }
  return rows.filter(row => row.pid !== panePid && owned.has(row.pid));
}

/** Remember birth identity before closing the TUI, since exec children can reparent. */
export async function stopTerminalChildren(children: OwnedTerminalProcess[]): Promise<void> {
  const expected = new Map(children.map(child => [child.pid, child.identity]));
  const live = async () => (await processes()).filter(row => expected.get(row.pid) === row.identity);
  const signal = (rows: OwnedTerminalProcess[], value: NodeJS.Signals): void => {
    for (const row of rows) {
      try { process.kill(row.pid, value); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  };
  signal(await live(), "SIGTERM");
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!(await live()).length) return;
    await delay(100);
  }
  signal(await live(), "SIGKILL");
  const forceDeadline = Date.now() + 1_000;
  while (Date.now() < forceDeadline) {
    if (!(await live()).length) return;
    await delay(100);
  }
  throw new Error("provider_stop_unconfirmed");
}
