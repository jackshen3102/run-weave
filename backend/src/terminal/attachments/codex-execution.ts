import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));
const helper =
  path.basename(directory) === "attachments"
    ? path.resolve(directory, "../../../.native-artifacts/resource-sampler")
    : path.join(directory, "resource-sampler");

/** Parse only recognized options before the first positional argument / -- boundary. */
export function hasLocalCodexBypass(args: readonly string[]): boolean {
  let bypass = false;
  const values = new Set([
    "-c",
    "--config",
    "-m",
    "--model",
    "-p",
    "--profile",
    "-C",
    "--cd",
    "--enable",
    "--disable",
    "--add-dir",
    "-i",
    "--image",
    "--local-provider",
  ]);
  const flags = new Set([
    "--no-alt-screen",
    "--no-daemon",
    "--search",
    "--oss",
    "--strict-config",
  ]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") return bypass;
    if (!arg.startsWith("-")) {
      if (arg === "resume" || arg === "fork") {
        const rest = args.slice(index + 1);
        return (
          bypass &&
          rest.length >= 1 &&
          rest.length <= 2 &&
          rest.every((value) => !value.startsWith("-"))
        );
      }
      if (
        [
          "exec",
          "e",
          "review",
          "login",
          "logout",
          "mcp",
          "plugin",
          "app-server",
          "remote-control",
          "app",
          "completion",
          "update",
          "doctor",
          "sandbox",
          "debug",
          "apply",
          "a",
          "queue",
          "archive",
          "delete",
          "unarchive",
          "migrate-rollouts",
          "cloud",
          "exec-server",
          "features",
          "help",
          "agents",
        ].includes(arg)
      )
        return false;
      return bypass && index === args.length - 1;
    }
    if (
      arg === "--yolo" ||
      arg === "--dangerously-bypass-approvals-and-sandbox"
    ) {
      bypass = true;
      continue;
    }
    const equals = arg.indexOf("=");
    const option = equals < 0 ? arg : arg.slice(0, equals);
    if (values.has(option)) {
      if (equals < 0 && ++index >= args.length) return false;
      continue;
    }
    if (flags.has(arg)) continue;
    // Unknown flags, remote endpoints and conflicting sandbox/approval options fail closed.
    return false;
  }
  return bypass;
}

/** Read native argv without parsing the prompt or shell display text. */
export async function readCodexProcessArguments(pid: number): Promise<string[] | null> {
  try {
    const { stdout } = await exec(helper, ["--process-argv", String(pid)], {
      encoding: "buffer",
      timeout: 3000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (stdout.at(-1) !== 0) return null;
    const [executable, command, ...args] = stdout
      .toString("utf8")
      .split("\0")
      .slice(0, -1);
    return path.basename(executable ?? "") === "codex" &&
      path.basename(command ?? "") === "codex" ? args : null;
  } catch {
    return null;
  }
}

export async function isLocalCodexBypass(pid: number): Promise<boolean> {
  const args = await readCodexProcessArguments(pid);
  return args !== null && hasLocalCodexBypass(args);
}
