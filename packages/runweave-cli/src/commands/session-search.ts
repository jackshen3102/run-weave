import path from "node:path";
import type { SessionSearchContext, SessionSearchResponse, SessionSearchStatus } from "@runweave/shared/session-search";
import { getStringOption, parseArgs, requireStringOption, resolveOutputMode } from "../args.js";
import { resolveAuthContext } from "../client/auth-context.js";
import { CliError } from "../errors.js";
import { writeOutput } from "../output/format.js";

export async function runSessionSearchCommand(command: string | undefined, args: string[],
  io: { stdout: Pick<NodeJS.WriteStream, "write">; env: NodeJS.ProcessEnv }) {
  if (!command || !["search", "show", "status", "index"].includes(command))
    throw new CliError("Usage: rw session-search <search --query text|show recordId|status|index> [--cwd path|--project-id id|--all-projects] [--provider codex|pi|claude] [--level chat|work|full] [--no-update] [--json]", 2);
  const { options, positionals } = parseArgs(args, new Set(["json", "plain", "no-update", "all-projects", "other-origins"]));
  const auth = await resolveAuthContext({ profileName: getStringOption(options, "profile"), backendPort: getStringOption(options, "backend-port"), env: io.env });
  let result: SessionSearchResponse | SessionSearchContext | SessionSearchStatus;
  let noUpdate = options["no-update"] === true;
  if ((command === "search" || command === "show") && noUpdate) {
    const status = await auth.requestJson<SessionSearchStatus>("/api/session-search/status");
    noUpdate = status.sources.some(source => source.sessions > 0);
  }
  if (command === "search") {
    const query = new URLSearchParams({ query: requireStringOption(options, "query") });
    if (options["all-projects"] === true) query.set("allProjects", "true");
    else if (options["project-id"]) query.set("projectId", requireStringOption(options, "project-id"));
    else query.set("cwd", path.resolve(getStringOption(options, "cwd") ?? process.cwd()));
    for (const [key, option] of [["provider", "provider"], ["level", "level"], ["from", "from"], ["to", "to"], ["limit", "limit"], ["cursor", "cursor"]]) {
      const value = getStringOption(options, option!);
      if (value) query.set(key!, value);
    }
    if (noUpdate) query.set("noUpdate", "true");
    if (options["other-origins"] === true) query.set("includeOtherOrigins", "true");
    result = await auth.requestJson<SessionSearchResponse>(`/api/session-search/search?${query}`);
  } else if (command === "show") {
    if (!positionals[0]) throw new CliError("Missing record id", 2);
    result = await auth.requestJson<SessionSearchContext>(`/api/session-search/records/${encodeURIComponent(positionals[0])}${noUpdate ? "?noUpdate=true" : ""}`);
  } else if (command === "status") result = await auth.requestJson<SessionSearchStatus>("/api/session-search/status");
  else result = await auth.requestJson<SessionSearchStatus>("/api/session-search/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (resolveOutputMode(options) === "json") writeOutput(io.stdout, "json", result);
  else if ("hits" in result) {
    for (const hit of result.hits) io.stdout.write(`${hit.id}\n${hit.provider} · ${hit.title}\n${hit.text}\n${hit.location.path}:${hit.location.line}\n\n`);
    io.stdout.write(`${result.hits.length} sessions${result.partial ? " (partial coverage)" : ""}${result.nextCursor ? "; nextCursor=" + result.nextCursor : ""}\n`);
  } else writeOutput(io.stdout, "json", result);
}
