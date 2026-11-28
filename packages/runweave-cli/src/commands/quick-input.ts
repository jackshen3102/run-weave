import {
  getStringOption,
  parseArgs,
  requireStringOption,
  resolveOutputMode,
} from "../args.js";
import { resolveAuthContext } from "../client/auth-context.js";
import { CliError } from "../errors.js";
import { writeOutput } from "../output/format.js";
import { readFile } from "node:fs/promises";
import type {
  CreateTerminalQuickInputRequest,
  TerminalQuickInputBackgroundRuntime,
  TerminalQuickInputMode,
  UpdateTerminalQuickInputRequest,
} from "@runweave/shared/terminal/input";

function parseBackgroundRuntime(
  value: string | undefined,
): TerminalQuickInputBackgroundRuntime | undefined {
  if (value === undefined) return undefined;
  if (value !== "headless" && value !== "terminal") {
    throw new CliError("--background-runtime must be headless or terminal", 2);
  }
  return value;
}

export async function runQuickInputCommand(
  command: string | undefined,
  args: string[],
  io: {
    stdout: Pick<NodeJS.WriteStream, "write">;
    env: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const usage =
    "Usage: rw quick-input list [--project-id <id>] [--kind all|pinned|recent] [--q <text>] [--limit 1..100] | rw quick-input create --title <title> --text-file <path> --client-import-id <UUID> [--mode line|codex_slash_command|prompt_paste] [--background-runtime headless|terminal] | rw quick-input update <id> [--text-file <path>] [--background-runtime headless|terminal] --expected-updated-at <timestamp> | rw quick-input run <id> --project-id <id> --expected-updated-at <timestamp> --idempotency-key <key> [--background-runtime headless|terminal] [--json]";
  if (
    command !== "list" &&
    command !== "run" &&
    command !== "create" &&
    command !== "update"
  )
    throw new CliError(usage, 2);
  const { options, positionals } = parseArgs(args, new Set(["json", "plain"]));
  const allowed = new Set([
    "profile",
    "backend-port",
    "instance",
    "config-dir",
    "json",
    "plain",
    ...(command === "list"
      ? ["project-id", "kind", "q", "limit"]
      : command === "create"
        ? [
            "title",
            "text-file",
            "mode",
            "background-runtime",
            "client-import-id",
          ]
        : command === "update"
          ? ["text-file", "background-runtime", "expected-updated-at"]
          : [
              "project-id",
              "expected-updated-at",
              "idempotency-key",
              "background-runtime",
            ]),
  ]);
  if (
    positionals.length !==
      (command === "run" || command === "update" ? 1 : 0) ||
    Object.keys(options).some((key) => !allowed.has(key))
  )
    throw new CliError(usage, 2);
  let route = "/api/terminal/quick-inputs";
  let init: RequestInit | undefined;
  if (command === "update") {
    const expectedUpdatedAt = requireStringOption(
      options,
      "expected-updated-at",
    );
    if (!Number.isFinite(Date.parse(expectedUpdatedAt)))
      throw new CliError("Invalid --expected-updated-at", 2);
    const textFile = getStringOption(options, "text-file");
    const backgroundRuntime = parseBackgroundRuntime(
      getStringOption(options, "background-runtime"),
    );
    if (!textFile && !backgroundRuntime) {
      throw new CliError(
        "update requires --text-file and/or --background-runtime",
        2,
      );
    }
    let data: string | undefined;
    if (textFile) {
      data = await readFile(textFile, "utf8");
      if (!data.trim())
        throw new CliError("--text-file must contain nonempty UTF-8 text", 2);
    }
    const payload: UpdateTerminalQuickInputRequest = {
      ...(data !== undefined ? { data } : {}),
      ...(backgroundRuntime ? { backgroundRuntime } : {}),
      expectedUpdatedAt,
    };
    route += `/${encodeURIComponent(positionals[0]!)}`;
    init = {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    };
  } else if (command === "create") {
    const title = requireStringOption(options, "title").trim();
    const mode = getStringOption(options, "mode") ?? "line";
    const backgroundRuntime = parseBackgroundRuntime(
      getStringOption(options, "background-runtime"),
    );
    const clientImportId = requireStringOption(options, "client-import-id");
    if (!title || title.length > 120)
      throw new CliError("--title must contain 1..120 characters", 2);
    if (!["line", "codex_slash_command", "prompt_paste"].includes(mode))
      throw new CliError("Invalid --mode", 2);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
        clientImportId,
      )
    )
      throw new CliError(
        "--client-import-id must be a UUID; reuse it when retrying the same import",
        2,
      );
    const data = await readFile(
      requireStringOption(options, "text-file"),
      "utf8",
    );
    if (!data.trim())
      throw new CliError("--text-file must contain nonempty UTF-8 text", 2);
    const payload: CreateTerminalQuickInputRequest = {
      title,
      data,
      mode: mode as TerminalQuickInputMode,
      ...(backgroundRuntime ? { backgroundRuntime } : {}),
      clientImportId,
    };
    init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    };
  } else if (command === "list") {
    const query = new URLSearchParams();
    for (const name of ["project-id", "kind", "q", "limit"]) {
      const value = getStringOption(options, name);
      if (value) query.set(name === "project-id" ? "projectId" : name, value);
    }
    const kind = query.get("kind");
    if (kind && !["all", "pinned", "recent"].includes(kind))
      throw new CliError("Invalid --kind", 2);
    const limit = query.get("limit");
    if (
      limit &&
      (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)
    )
      throw new CliError("--limit must be between 1 and 100", 2);
    if (query.size) route += `?${query}`;
  } else {
    const key = requireStringOption(options, "idempotency-key");
    if (!key.trim() || key.length > 200)
      throw new CliError("Invalid idempotency key", 2);
    const timestamp = requireStringOption(options, "expected-updated-at");
    if (!Number.isFinite(Date.parse(timestamp)))
      throw new CliError("Invalid --expected-updated-at", 2);
    const backgroundRuntime = parseBackgroundRuntime(
      getStringOption(options, "background-runtime"),
    );
    route += `/${encodeURIComponent(positionals[0]!)}/run`;
    init = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({
        projectId: requireStringOption(options, "project-id"),
        expectedInputUpdatedAt: timestamp,
        ...(backgroundRuntime ? { backgroundRuntime } : {}),
      }),
    };
  }
  const auth = await resolveAuthContext({
    profileName: getStringOption(options, "profile"),
    backendPort: getStringOption(options, "backend-port"),
    env: io.env,
  });
  writeOutput(
    io.stdout,
    resolveOutputMode(options),
    await auth.requestJson(route, init),
  );
}
