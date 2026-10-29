import { readFile } from "node:fs/promises";
import {
  getStringOption,
  parseArgs,
  requireStringOption,
  resolveOutputMode,
} from "../args.js";
import { resolveAuthContext } from "../client/auth-context.js";
import { CliError } from "../errors.js";
import { writeOutput } from "../output/format.js";

const USAGE =
  "Usage: rw scheduled-task run <start|list|get|output|stop|continue|open-terminal|archive> [id] [--task-id <id>|--source quick-input] [--cursor <cursor>] [--limit 1..100] [--idempotency-key <key>] [--revision <revision>] [--reply-file <path>] [--json]";

export async function runScheduledTaskRunCommand(
  args: string[],
  io: {
    stdout: Pick<NodeJS.WriteStream, "write">;
    env: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const [command, ...rest] = args;
  if (
    !command ||
    ![
      "start",
      "list",
      "get",
      "output",
      "stop",
      "continue",
      "open-terminal",
      "archive",
    ].includes(command)
  )
    throw new CliError(USAGE, 2);
  const { options, positionals } = parseArgs(rest, new Set(["json", "plain"]));
  const allowed = new Set([
    "profile",
    "backend-port",
    "instance",
    "config-dir",
    "json",
    "plain",
    ...(command === "list"
      ? ["task-id", "source", "project-id", "finished-since", "cursor", "limit"]
      : []),
    ...(command === "output" ? ["cursor"] : []),
    ...(["start", "continue"].includes(command) ? ["idempotency-key"] : []),
    ...(command === "continue" ? ["revision", "reply-file"] : []),
  ]);
  if (
    Object.keys(options).some((key) => !allowed.has(key)) ||
    positionals.length !== (command === "list" ? 0 : 1)
  )
    throw new CliError(USAGE, 2);
  const query = new URLSearchParams();
  let route = "/api/scheduled-tasks";
  let init: RequestInit | undefined;
  if (command === "list") {
    const taskId = getStringOption(options, "task-id");
    const source = getStringOption(options, "source");
    if (
      Boolean(taskId) === Boolean(source) ||
      (source && source !== "quick-input")
    )
      throw new CliError("Provide --task-id or --source quick-input", 2);
    if (taskId && (options["project-id"] || options["finished-since"]))
      throw new CliError(
        "--project-id and --finished-since require --source quick-input",
        2,
      );
    route += taskId ? `/${encodeURIComponent(taskId)}/runs` : "/runs";
    for (const [option, field] of [
      ["source", "source"],
      ["project-id", "projectId"],
      ["finished-since", "finishedSince"],
      ["cursor", "cursor"],
      ["limit", "limit"],
    ]) {
      const value = getStringOption(options, option!);
      if (value) query.set(field!, value);
    }
    if (
      query.has("limit") &&
      (!/^\d+$/.test(query.get("limit")!) ||
        Number(query.get("limit")) < 1 ||
        Number(query.get("limit")) > 100)
    )
      throw new CliError("--limit must be between 1 and 100", 2);
  } else {
    const id = encodeURIComponent(positionals[0]!);
    route +=
      command === "start"
        ? `/${id}/runs`
        : `/runs/${id}${command === "get" ? "" : `/${command}`}`;
    if (command === "output") {
      const cursor = getStringOption(options, "cursor");
      if (cursor) query.set("cursor", cursor);
    } else if (command !== "get") {
      const body: { expectedRevision?: number; reply?: string } = {};
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (command === "start" || command === "continue") {
        const key = requireStringOption(options, "idempotency-key");
        if (!key.trim() || key.length > 200)
          throw new CliError("Invalid idempotency key", 2);
        headers["Idempotency-Key"] = key;
      }
      if (command === "continue") {
        const revision = requireStringOption(options, "revision");
        if (
          !/^\d+$/.test(revision) ||
          !Number.isSafeInteger(Number(revision)) ||
          Number(revision) < 1
        )
          throw new CliError("--revision must be a positive integer", 2);
        body.expectedRevision = Number(revision);
        const file = getStringOption(options, "reply-file");
        if (file) {
          body.reply = await readFile(file, "utf8");
          if (!body.reply.trim() || body.reply.trim().length > 8000)
            throw new CliError("Reply must contain 1..8000 characters", 2);
        }
      }
      init = { method: "POST", headers, body: JSON.stringify(body) };
    }
  }
  const auth = await resolveAuthContext({
    profileName: getStringOption(options, "profile"),
    backendPort: getStringOption(options, "backend-port"),
    env: io.env,
  });
  const result = await auth.requestJson(
    `${route}${query.size ? `?${query}` : ""}`,
    init,
  );
  writeOutput(io.stdout, resolveOutputMode(options), result);
}
