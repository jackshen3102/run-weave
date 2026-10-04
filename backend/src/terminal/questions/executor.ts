import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { readCodexProcessArguments } from "../attachments/codex-execution";

const exec = promisify(execFile);

/** Only explicit remote argv before the prompt counts; prompt text is never an endpoint. */
function remoteSocket(args: string[]): string | null {
  const values = new Set(["-c", "--config", "-m", "--model", "-p", "--profile", "-C", "--cd", "--enable", "--disable", "--add-dir", "-i", "--image", "--local-provider", "--sandbox", "-s", "--ask-for-approval", "-a"]);
  let socket: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("-") || arg === "--") break;
    const [flag, inline] = arg.split("=", 2);
    if (flag === "--remote") {
      const endpoint = inline ?? args[++index];
      if (!endpoint?.startsWith("unix:///")) return null;
      socket = endpoint.slice("unix://".length);
      if (/[:\s%?#]/.test(socket)) return null;
    } else if (values.has(flag!)) {
      if (inline === undefined) index++;
    } else if (!["--no-alt-screen", "--no-daemon", "--search", "--yolo", "--dangerously-bypass-approvals-and-sandbox", "--full-auto", "--strict-config"].includes(arg)) {
      return null;
    }
  }
  return socket;
}

export async function findQuestionExecutor(panePid: number): Promise<{ pid: number; socket: string } | null> {
  const { stdout } = await exec("ps", ["-ww", "-axo", "pid=,ppid=,uid="], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
  const processes = stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), uid: Number(match[3]) }] : [];
  });
  const descendants = new Set([panePid]);
  for (let iteration = 0; iteration < processes.length; iteration++) {
    const before = descendants.size;
    for (const entry of processes) if (descendants.has(entry.parent)) descendants.add(entry.pid);
    if (before === descendants.size) break;
  }
  const candidates: { pid: number; socket: string }[] = [];
  for (const entry of processes) {
    if (!descendants.has(entry.pid) || entry.uid !== process.getuid?.()) continue;
    const args = await readCodexProcessArguments(entry.pid);
    const socket = args && remoteSocket(args);
    if (!socket) continue;
    const info = await stat(socket).catch(() => null);
    if (info?.isSocket() && info.uid === entry.uid) candidates.push({ pid: entry.pid, socket });
  }
  return candidates.length === 1 ? candidates[0]! : null;
}
