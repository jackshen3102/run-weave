import { readFile } from "node:fs/promises";
import type {
  CollectEfficiencyResponse,
  ExecutionEfficiencyStatus,
  SubmitEfficiencyResultRequest,
  SubmitEfficiencyResultResponse,
} from "@runweave/shared/execution-efficiency";
import {
  getStringOption,
  parseArgs,
  requireStringOption,
  resolveOutputMode,
} from "../args.js";
import { resolveAuthContext } from "../client/auth-context.js";
import { CliError } from "../errors.js";
import { writeOutput } from "../output/format.js";

type Io = {
  stdout: Pick<NodeJS.WriteStream, "write">;
  env: NodeJS.ProcessEnv;
};

const USAGE =
  "Usage: rw efficiency <status|collect|submit> [--project-id id] [--scheduled-run-id id] [--analysis-id id] [--file path] [--idempotency-key key] [--profile name|--backend-port port] [--json]";

export async function runEfficiencyCommand(
  command: string | undefined,
  args: string[],
  io: Io,
): Promise<void> {
  if (!command || !["status", "collect", "submit"].includes(command))
    throw new CliError(USAGE, 2);
  const { options, positionals } = parseArgs(args, new Set(["json", "plain"]));
  if (positionals.length) throw new CliError(USAGE, 2);
  const mode = resolveOutputMode(options);
  const auth = await resolveAuthContext({
    profileName: getStringOption(options, "profile"),
    backendPort: getStringOption(options, "backend-port"),
    env: io.env,
  });
  const root = "/api/execution-efficiency";
  let result: unknown;
  if (command === "status") {
    const targetProjectId = projectId(options, io.env);
    result = await auth.requestJson<ExecutionEfficiencyStatus>(
      `${root}/status?projectId=${encodeURIComponent(targetProjectId)}`,
    );
  } else if (command === "collect") {
    const targetProjectId = projectId(options, io.env);
    const scheduledRunId =
      getStringOption(options, "scheduled-run-id") ??
      io.env.RUNWEAVE_SCHEDULED_TASK_RUN_ID?.trim();
    if (!scheduledRunId)
      throw new CliError("--scheduled-run-id is required outside a scheduled run", 2);
    result = await auth.requestJson<CollectEfficiencyResponse>(
      `${root}/collections`,
      jsonRequest(
        "POST",
        { projectId: targetProjectId, scheduledRunId },
        requireKey(options),
      ),
    );
  } else {
    const analysisId = requireStringOption(options, "analysis-id");
    const body = await readSubmitFile(requireStringOption(options, "file"));
    result = await auth.requestJson<SubmitEfficiencyResultResponse>(
      `${root}/analyses/${encodeURIComponent(analysisId)}/result`,
      jsonRequest("POST", body, requireKey(options)),
    );
  }
  writeOutput(
    io.stdout,
    mode,
    mode === "json" ? result : JSON.stringify(result, null, 2),
  );
}

function projectId(
  options: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv,
): string {
  const value = getStringOption(options, "project-id") ?? env.RUNWEAVE_PROJECT_ID?.trim();
  if (!value)
    throw new CliError("--project-id is required outside a scheduled run", 2);
  return value;
}

function requireKey(options: Record<string, string | boolean>): string {
  const key = requireStringOption(options, "idempotency-key");
  if (key.length > 200) throw new CliError("Idempotency key is too long", 2);
  return key;
}

async function readSubmitFile(filePath: string): Promise<SubmitEfficiencyResultRequest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new CliError("Result file must contain valid JSON", 2);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new CliError("Result file must contain a JSON object", 2);
  return parsed as SubmitEfficiencyResultRequest;
}

function jsonRequest(method: "POST", body: unknown, key: string): RequestInit {
  return {
    method,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(body),
  };
}
