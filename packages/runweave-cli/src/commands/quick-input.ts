import {
  getStringOption,
  parseArgs,
  requireStringOption,
  resolveOutputMode,
} from "../args.js";
import { resolveAuthContext } from "../client/auth-context.js";
import { CliError } from "../errors.js";
import { writeOutput } from "../output/format.js";

export async function runQuickInputCommand(
  command: string | undefined,
  args: string[],
  io: {
    stdout: Pick<NodeJS.WriteStream, "write">;
    env: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const usage =
    "Usage: rw quick-input list [--project-id <id>] [--kind all|pinned|recent] [--q <text>] [--limit 1..100] | rw quick-input run <id> --project-id <id> --expected-updated-at <timestamp> --idempotency-key <key> [--json]";
  if (command !== "list" && command !== "run") throw new CliError(usage, 2);
  const { options, positionals } = parseArgs(args, new Set(["json", "plain"]));
  const allowed = new Set([
    "profile",
    "backend-port",
    "instance",
    "config-dir",
    "json",
    "plain",
    "project-id",
    ...(command === "list"
      ? ["kind", "q", "limit"]
      : ["expected-updated-at", "idempotency-key"]),
  ]);
  if (
    positionals.length !== (command === "list" ? 0 : 1) ||
    Object.keys(options).some((key) => !allowed.has(key))
  )
    throw new CliError(usage, 2);
  let route = "/api/terminal/quick-inputs";
  let init: RequestInit | undefined;
  if (command === "list") {
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
    route += `/${encodeURIComponent(positionals[0]!)}/run`;
    init = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({
        projectId: requireStringOption(options, "project-id"),
        expectedInputUpdatedAt: timestamp,
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
