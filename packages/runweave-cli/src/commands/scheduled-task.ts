import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  ScheduledTask,
  ScheduledTaskCapabilities,
  ScheduledTaskPage,
  ScheduledTaskValidation,
} from "@runweave/shared/scheduled-tasks";
import {
  getStringOption,
  parseArgs,
  requireStringOption,
  resolveOutputMode,
} from "../args.js";
import { resolveAuthContext } from "../client/auth-context.js";
import { CliError } from "../errors.js";
import { writeOutput } from "../output/format.js";
import { runScheduledTaskMigrationCommand } from "./scheduled-task-migration.js";
import { runScheduledTaskRunCommand } from "./scheduled-task-run.js";

type Io = { stdout: Pick<NodeJS.WriteStream, "write">; env: NodeJS.ProcessEnv };

const USAGE =
  "Usage: rw scheduled-task <migration|capabilities|list|get|validate-create|create|validate-update|update|run> [task-id] [--file path] [--sha256 digest] [--expected-backend url] [--idempotency-key key] [--profile name|--backend-port port] [--json]";

export async function runScheduledTaskCommand(
  command: string | undefined,
  args: string[],
  io: Io,
): Promise<void> {
  if (command === "migration") {
    await runScheduledTaskMigrationCommand(args, io);
    return;
  }
  if (command === "run") {
    await runScheduledTaskRunCommand(args, io);
    return;
  }
  if (
    !command ||
    ![
      "capabilities",
      "list",
      "get",
      "validate-create",
      "create",
      "validate-update",
      "update",
    ].includes(command)
  ) {
    throw new CliError(USAGE, 2);
  }
  const { options, positionals } = parseArgs(args, new Set(["json", "plain"]));
  const mode = resolveOutputMode(options);
  if (options["project-id"] || options["parent-project-id"]) throw new CliError("普通定时任务不再支持项目筛选", 2);
  const taskId = ["get", "validate-update", "update"].includes(command)
    ? requireTaskId(positionals)
    : undefined;
  if (!taskId && positionals.length) throw new CliError(USAGE, 2);

  const request = [
    "validate-create",
    "create",
    "validate-update",
    "update",
  ].includes(command)
    ? await readRequest(requireStringOption(options, "file"))
    : null;
  if (command === "create" || command === "update") {
    const expected = requireStringOption(options, "sha256").toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(expected) || expected !== request?.sha256)
      throw new CliError(
        "Request file changed since review; validate and confirm it again",
        2,
      );
  }

  const auth = await resolveAuthContext({
    profileName: getStringOption(options, "profile"),
    backendPort: getStringOption(options, "backend-port"),
    env: io.env,
  });
  if (
    (command === "create" || command === "update") &&
    auth.baseUrl !== requireStringOption(options, "expected-backend")
  ) {
    throw new CliError(
      "Backend changed since review; validate and confirm it again",
      2,
    );
  }
  const root = "/api/scheduled-tasks";
  if (command !== "capabilities") {
    const capabilities = await auth.requestJson<ScheduledTaskCapabilities>(`${root}/capabilities`);
    if (capabilities.taskContextVersion !== 2) throw new CliError("定时任务协议不兼容，请更新 Backend", 2);
  }
  const taskPath = taskId ? `${root}/${encodeURIComponent(taskId)}` : root;
  let result: unknown;

  switch (command) {
    case "capabilities":
      result = await auth.requestJson<ScheduledTaskCapabilities>(
        `${root}/capabilities`,
      );
      break;
    case "list": {
      const query = new URLSearchParams();
      for (const name of [
        "q",
        "archived",
        "cursor",
        "limit",
      ] as const) {
        const value = getStringOption(options, name);
        if (value)
          query.set(
            name.replaceAll(/-([a-z])/gu, (_, letter: string) =>
              letter.toUpperCase(),
            ),
            value,
          );
      }
      result = await auth.requestJson<ScheduledTaskPage<ScheduledTask>>(
        `${root}${query.size ? `?${query}` : ""}`,
      );
      break;
    }
    case "get":
      result = await auth.requestJson<ScheduledTask>(taskPath);
      break;
    case "validate-create":
    case "validate-update": {
      const validation = await auth.requestJson<ScheduledTaskValidation>(
        command === "validate-create"
          ? `${root}/validate-create`
          : `${taskPath}/validate-update`,
        jsonRequest("POST", request!.body),
      );
      result = {
        backend: auth.baseUrl,
        profile: auth.profileName,
        ...(taskId ? { taskId } : {}),
        sha256: request!.sha256,
        request: request!.body,
        validation,
      };
      break;
    }
    case "create": {
      const key = requireStringOption(options, "idempotency-key");
      if (key.length > 200)
        throw new CliError("Idempotency key is too long", 2);
      result = await auth.requestJson<ScheduledTask>(root, {
        ...jsonRequest("POST", request!.body),
        headers: {
          "Content-Type": "application/json", "X-Runweave-Task-Context-Version": "2",
          "Idempotency-Key": key,
        },
      });
      break;
    }
    case "update":
      result = await auth.requestJson<ScheduledTask>(
        taskPath,
        jsonRequest("PATCH", request!.body),
      );
      break;
  }

  writeOutput(
    io.stdout,
    mode,
    mode === "json" ? result : JSON.stringify(result, null, 2),
  );
}

function requireTaskId(positionals: string[]): string {
  if (positionals.length !== 1 || !positionals[0]) throw new CliError(USAGE, 2);
  return positionals[0];
}

async function readRequest(
  filePath: string,
): Promise<{ body: object; sha256: string }> {
  const bytes = await readFile(filePath);
  let body: unknown;
  try {
    body = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CliError("Request file must contain valid JSON", 2);
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new CliError("Request file must contain a JSON object", 2);
  return { body, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function jsonRequest(method: "POST" | "PATCH", body: object): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json", "X-Runweave-Task-Context-Version": "2" },
    body: JSON.stringify(body),
  };
}
