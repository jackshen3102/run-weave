import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  ScheduledTask,
  ScheduledTaskCapabilities,
  ScheduledTaskPage,
  ScheduledTaskValidation,
} from "@runweave/shared/scheduled-tasks";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
import type { TerminalProjectContextListItem } from "@runweave/shared/terminal/project-context";
import {
  getStringOption,
  parseArgs,
  requireStringOption,
  resolveOutputMode,
} from "../args.js";
import { resolveAuthContext } from "../client/auth-context.js";
import { CliError } from "../errors.js";
import { writeOutput } from "../output/format.js";

type Io = { stdout: Pick<NodeJS.WriteStream, "write">; env: NodeJS.ProcessEnv };

const USAGE =
  "Usage: rw scheduled-task <projects|capabilities|list|get|validate-create|create|validate-update|update> [task-id] [--file path] [--sha256 digest] [--expected-backend url] [--idempotency-key key] [--profile name|--backend-port port] [--json]";

export async function runScheduledTaskCommand(
  command: string | undefined,
  args: string[],
  io: Io,
): Promise<void> {
  if (
    !command ||
    ![
      "projects",
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
  const taskPath = taskId ? `${root}/${encodeURIComponent(taskId)}` : root;
  let result: unknown;

  switch (command) {
    case "projects": {
      const projects = await auth.requestJson<TerminalProjectListItem[]>(
        "/api/terminal/project",
      );
      result = await Promise.all(
        projects.map(async (project) => ({
          ...project,
          contexts: await auth.requestJson<TerminalProjectContextListItem[]>(
            `/api/terminal/project/${encodeURIComponent(project.projectId)}/contexts`,
          ),
        })),
      );
      break;
    }
    case "capabilities":
      result = await auth.requestJson<ScheduledTaskCapabilities>(
        `${root}/capabilities`,
      );
      break;
    case "list": {
      const query = new URLSearchParams();
      for (const name of [
        "project-id",
        "parent-project-id",
        "q",
        "archived",
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
          "Content-Type": "application/json",
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
