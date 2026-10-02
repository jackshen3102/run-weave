import { parseArgs, getStringOption, resolveOutputMode } from "../args.js";
import { resolveAuthContext } from "../client/auth-context.js";
import { writeOutput } from "../output/format.js";
import { CliError } from "../errors.js";
import { serviceManagementSnapshot } from "@runweave/shared/service-management";
import type { RuntimeNodeStatusSnapshot } from "@runweave/shared/runtime-status";

export async function runStatusCommand(args: string[], io: {
  stdout: Pick<NodeJS.WriteStream, "write">; env: NodeJS.ProcessEnv;
}): Promise<void> {
  const parsed = parseArgs(args, new Set(["json", "plain"]));
  if (parsed.positionals.length) throw new CliError("Usage: rw status [--profile <name>] [--backend-port <port>] [--json]", 2);
  const auth = await resolveAuthContext({ profileName: getStringOption(parsed.options, "profile"), backendPort: getStringOption(parsed.options, "backend-port"), env: io.env });
  const snapshot = await auth.requestJson<RuntimeNodeStatusSnapshot>("/api/runtime-status");
  if (snapshot.protocolVersion !== 1 || !Array.isArray(snapshot.reports)) throw new CliError("Unsupported runtime status protocol", 3);
  writeOutput(io.stdout, resolveOutputMode(parsed.options), { profile: auth.profileName, baseUrl: auth.baseUrl, ...serviceManagementSnapshot(snapshot) });
}
