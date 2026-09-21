import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ExperienceDraft,
  ExperienceDiagnostics,
  ExperienceLearningStatus,
  ExperienceFeedback,
  ExperienceFeedbackInput,
  ExperienceSearchResult,
  ExperienceView,
} from "@runweave/shared/experience";
import {
  getStringOption,
  parseArgs,
  requireStringOption,
  resolveOutputMode,
} from "../args.js";
import { resolveAuthContext } from "../client/auth-context.js";
import { CliError } from "../errors.js";
import { writeOutput } from "../output/format.js";

const usage =
  "Usage: rw experience <search --query text|show id|save --file record.json|feedback --file receipt.json|history|status|diagnose [--query text]|retry jobId> [--cwd path] [--json]";
export async function runExperienceCommand(
  command: string | undefined,
  args: string[],
  io: { stdout: Pick<NodeJS.WriteStream, "write">; env: NodeJS.ProcessEnv },
): Promise<void> {
  if (
    !command ||
    ![
      "search",
      "show",
      "save",
      "feedback",
      "history",
      "status",
      "diagnose",
      "retry",
    ].includes(command)
  )
    throw new CliError(usage, 2);
  const { options, positionals } = parseArgs(args, new Set(["json", "plain"]));
  const cwd = path.resolve(getStringOption(options, "cwd") ?? process.cwd());
  const auth = await resolveAuthContext({
    profileName: getStringOption(options, "profile"),
    backendPort: getStringOption(options, "backend-port"),
    env: io.env,
  });
  const post = <T>(route: string, body: unknown) =>
    auth.requestJson<T>(`/api/experience/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const readJson = async <T>(): Promise<T> => {
    const file = requireStringOption(options, "file");
    try {
      return JSON.parse(await readFile(file, "utf8")) as T;
    } catch {
      throw new CliError(`Cannot read JSON file: ${file}`, 2);
    }
  };
  let result:
    | ExperienceLearningStatus
    | ExperienceDiagnostics
    | { queued: boolean }
    | ExperienceSearchResult
    | ExperienceView
    | ExperienceFeedback
    | ExperienceFeedback[];
  if (command === "diagnose") {
    const query = getStringOption(options, "query");
    result = await auth.requestJson<ExperienceDiagnostics>(
      `/api/experience/diagnose?${new URLSearchParams({ cwd, ...(query === undefined ? {} : { query }) })}`,
    );
  } else if (command === "status") {
    result = await auth.requestJson<ExperienceLearningStatus>(
      `/api/experience/status?${new URLSearchParams({ cwd })}`,
    );
  } else if (command === "retry") {
    if (!positionals[0]) throw new CliError("Missing job id", 2);
    result = await post<{ queued: boolean }>("retry", {
      cwd,
      jobId: positionals[0],
    });
  } else if (command === "search") {
    result = await post<ExperienceSearchResult>("search", {
      cwd,
      query: requireStringOption(options, "query"),
    });
  } else if (command === "show") {
    if (!positionals[0]) throw new CliError("Missing experience id", 2);
    result = await auth.requestJson<ExperienceView>(
      `/api/experience/records/${encodeURIComponent(positionals[0])}?${new URLSearchParams({ cwd })}`,
    );
  } else if (command === "save") {
    result = await post<ExperienceView>("records", {
      cwd,
      record: await readJson<ExperienceDraft>(),
      expectedRevision: getStringOption(options, "expected-revision"),
    });
  } else if (command === "feedback") {
    result = await post<ExperienceFeedback>("feedback", {
      cwd,
      feedback: await readJson<ExperienceFeedbackInput>(),
    });
  } else {
    result = await auth.requestJson<ExperienceFeedback[]>(
      `/api/experience/feedback?${new URLSearchParams({ cwd })}`,
    );
  }
  const mode = resolveOutputMode(options);
  writeOutput(
    io.stdout,
    mode,
    mode === "json" ? result : JSON.stringify(result, null, 2),
  );
}
