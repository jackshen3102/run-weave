import crypto from "node:crypto";
import type {
  ActivityBatchWriteResponse,
  ActivityEventInput,
  ActivityEventName,
  ActivityFactsQuery,
  ActivityPayload,
  ActivityOperationScope,
  ActivityDeleteJobDto,
} from "@runweave/shared/activity";
import {
  getStringOption,
  parseArgs,
  requireStringOption,
  resolveOutputMode,
} from "../args.js";
import { resolveAuthContext } from "../client/auth-context.js";
import { CliError } from "../errors.js";
import { writeOutput } from "../output/format.js";

type ActivityIo = {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stdin: NodeJS.ReadStream;
  env: NodeJS.ProcessEnv;
};

function writeActivityOutput(
  stdout: Pick<NodeJS.WriteStream, "write">,
  mode: "json" | "plain",
  payload: unknown,
): void {
  writeOutput(
    stdout,
    payload !== null && typeof payload === "object" ? "json" : mode,
    payload,
  );
}

function buildQuery(options: Record<string, string | boolean>): ActivityFactsQuery {
  return {
    runtimeChannel: getStringOption(options, "runtime") as
      | ActivityFactsQuery["runtimeChannel"]
      | undefined,
    runtimeSurface: getStringOption(options, "surface") as
      | ActivityFactsQuery["runtimeSurface"]
      | undefined,
    projectId: getStringOption(options, "project-id"),
    terminalSessionId: getStringOption(options, "terminal-session-id"),
    threadId: getStringOption(options, "thread-id"),
    runId: getStringOption(options, "run-id"),
    eventName: getStringOption(options, "event") as ActivityEventName | undefined,
    search: getStringOption(options, "search"),
    limit: getStringOption(options, "limit")
      ? Number(getStringOption(options, "limit"))
      : undefined,
  };
}

function queryString(values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

function buildEvent(params: {
  eventName: ActivityEventName;
  payload: ActivityPayload;
  scope?: ActivityEventInput["scope"];
  result?: ActivityEventInput["result"];
  content?: { role: "command" | "query" | "response"; text: string };
}): ActivityEventInput {
  const now = new Date().toISOString();
  return {
    eventId: crypto.randomUUID(),
    eventName: params.eventName,
    schemaVersion: 1,
    occurredAt: now,
    producer: {
      name: "runweave-cli",
      version: "builtin",
      instanceId: `cli:${process.pid}`,
      bootId: crypto.randomUUID(),
      bootStartedAt: now,
      sequence: 1,
    },
    actor: { type: "user" },
    runtime: { channel: "external", surface: "cli" },
    scope: params.scope ?? {},
    ...(params.result ? { result: params.result } : {}),
    payload: params.payload,
    contents: params.content
      ? [
          {
            contentId: crypto.randomUUID(),
            role: params.content.role,
            mediaType: "text/plain; charset=utf-8",
            bytesBase64: Buffer.from(params.content.text, "utf8").toString("base64"),
          },
        ]
      : [],
    externalRefs: [],
  };
}

async function readStdin(stdin: NodeJS.ReadStream): Promise<string> {
  stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of stdin) value += chunk;
  return value;
}

export async function runActivityCommand(
  subcommand: string | undefined,
  args: string[],
  io: ActivityIo,
): Promise<void> {
  if (!subcommand) {
    throw new CliError(
      "Usage: rw activity <facts|timeline|sources|record> [options]",
      2,
    );
  }
  const parsed = parseArgs(
    args,
    new Set(["json", "plain", "command-stdin"]),
  );
  const mode = resolveOutputMode(parsed.options);
  const auth = await resolveAuthContext({
    profileName: getStringOption(parsed.options, "profile"),
    backendPort: getStringOption(parsed.options, "backend-port"),
    env: io.env,
  });

  if (subcommand === "facts") {
    const query = buildQuery(parsed.options);
    const payload = await auth.requestJson(
      `/api/activity/facts${queryString({
        runtimeChannel: query.runtimeChannel,
        runtimeSurface: query.runtimeSurface,
        projectId: query.projectId,
        terminalSessionId: query.terminalSessionId,
        threadId: query.threadId,
        runId: query.runId,
        eventName: query.eventName,
        search: query.search,
        limit: query.limit,
      })}`,
    );
    writeActivityOutput(io.stdout, mode, payload);
    return;
  }

  if (subcommand === "timeline") {
    const selectors = [
      ["interaction-id", "interaction"],
      ["correlation-id", "correlation"],
      ["thread-id", "thread"],
      ["run-id", "run"],
    ] as const;
    const selected = selectors.flatMap(([option, type]) => {
      const id = getStringOption(parsed.options, option);
      return id ? [{ type, id }] : [];
    });
    if (selected.length !== 1) {
      throw new CliError(
        "Pass exactly one of --interaction-id, --correlation-id, --thread-id or --run-id",
        2,
      );
    }
    writeActivityOutput(
      io.stdout,
      mode,
      await auth.requestJson(
        `/api/activity/timelines${queryString({
          selector: selected[0]!.type,
          id: selected[0]!.id,
        })}`,
      ),
    );
    return;
  }

  if (subcommand === "sources") {
    writeActivityOutput(io.stdout, mode, await auth.requestJson("/api/activity/sources"));
    return;
  }

  if (subcommand === "export" || subcommand === "delete") {
    if (subcommand === "delete" && parsed.positionals[0] === "status") {
      const deleteJobId = parsed.positionals[1];
      if (!deleteJobId) throw new CliError("Missing delete job id", 2);
      writeActivityOutput(
        io.stdout,
        mode,
        await auth.requestJson<ActivityDeleteJobDto>(
          `/api/activity/delete-jobs/${encodeURIComponent(deleteJobId)}`,
        ),
      );
      return;
    }

    const projectId = getStringOption(parsed.options, "project-id");
    const threadId = getStringOption(parsed.options, "thread-id");
    if (Number(Boolean(projectId)) + Number(Boolean(threadId)) !== 1) {
      throw new CliError("Pass exactly one of --project-id or --thread-id", 2);
    }
    const scope: ActivityOperationScope = projectId
      ? { projectId }
      : { threadId: threadId as string };
    writeActivityOutput(
      io.stdout,
      mode,
      await auth.requestJson(
        "/api/activity/operations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: subcommand, scope }),
        },
      ),
    );
    return;
  }

  if (subcommand !== "record") {
    throw new CliError(`Unknown activity command: ${subcommand}`, 2);
  }

  const recordType = parsed.positionals[0];
  let event: ActivityEventInput;
  if (recordType === "terminal-command-started") {
    const command = await readStdin(io.stdin);
    if (!command.trim()) throw new CliError("--command-stdin requires command text on stdin", 2);
    event = buildEvent({
      eventName: "terminal.command.started",
      scope: {
        operationId: requireStringOption(parsed.options, "operation-id"),
        cwd: requireStringOption(parsed.options, "cwd"),
      },
      payload: {},
      content: { role: "command", text: command },
    });
  } else if (recordType === "terminal-command-completed") {
    const exitCode = Number(requireStringOption(parsed.options, "exit-code"));
    if (!Number.isInteger(exitCode)) throw new CliError("--exit-code must be an integer", 2);
    event = buildEvent({
      eventName: "terminal.command.completed",
      scope: {
        operationId: requireStringOption(parsed.options, "operation-id"),
        cwd: requireStringOption(parsed.options, "cwd"),
      },
      payload: { exitCode },
      result: { status: exitCode === 0 ? "succeeded" : "failed", code: String(exitCode) },
    });
  } else if (recordType === "agent-hook") {
    const raw = JSON.parse(await readStdin(io.stdin)) as ActivityEventInput;
    event = raw;
  } else {
    throw new CliError(
      "Usage: rw activity record <terminal-command-started|terminal-command-completed|agent-hook> [options]",
      2,
    );
  }

  const route = recordType === "agent-hook" ? "hook-events" : "shell-command-events";
  let response: ActivityBatchWriteResponse;
  try {
    response = await auth.requestJson<ActivityBatchWriteResponse>(
      `/api/activity/${route}/batch`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: [event] }),
      },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Backend unavailable";
    throw new CliError(`Activity event was not recorded: ${reason}`, 1);
  }
  writeActivityOutput(io.stdout, mode, response);
}
