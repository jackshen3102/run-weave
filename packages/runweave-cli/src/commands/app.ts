import { getStringOption, parseArgs, resolveOutputMode } from "../args.js";
import { AppHttpClient } from "../client/app-http-client.js";
import { resolveCliBaseUrl } from "../client/cli-base-url.js";
import { CliError } from "../errors.js";
import { writeOutput } from "../output/format.js";

export async function runAppCommand(
  subcommand: string | undefined,
  args: string[],
  io: {
    stdout: Pick<NodeJS.WriteStream, "write">;
    env: NodeJS.ProcessEnv;
  },
): Promise<void> {
  if (subcommand !== "overview") {
    throw new CliError("Usage: rw app overview [--json]", 2);
  }

  const parsed = parseArgs(args, new Set(["json", "plain"]));
  const mode = resolveOutputMode(parsed.options);
  const context = await resolveCliBaseUrl({
    profileName: getStringOption(parsed.options, "profile"),
    backendPort: getStringOption(parsed.options, "backend-port"),
    env: io.env,
  });
  const client = new AppHttpClient(context.baseUrl, context.accessToken);
  writeOutput(io.stdout, mode, await client.getOverview());
}
