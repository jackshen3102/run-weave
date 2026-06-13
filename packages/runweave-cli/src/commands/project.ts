import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  getStringOption,
  parseArgs,
  requireStringOption,
  resolveOutputMode,
} from "../args.js";
import { resolveAuthContext } from "../client/auth-context.js";
import { TerminalHttpClient } from "../client/terminal-http-client.js";
import { CliError } from "../errors.js";
import { writeOutput } from "../output/format.js";

export async function runProjectCommand(
  subcommand: string | undefined,
  args: string[],
  io: {
    stdout: Pick<NodeJS.WriteStream, "write">;
    env: NodeJS.ProcessEnv;
  },
): Promise<void> {
  if (subcommand !== "ensure" && subcommand !== "list") {
    throw new CliError(
      "Usage: rw project <list|ensure> [options]",
      2,
    );
  }

  const parsed = parseArgs(args, new Set(["json", "plain"]));
  const mode = resolveOutputMode(parsed.options);
  const auth = await resolveAuthContext({
    profileName: getStringOption(parsed.options, "profile"),
    env: io.env,
  });
  const client = new TerminalHttpClient(auth);

  if (subcommand === "list") {
    writeOutput(io.stdout, mode, await client.listProjects());
    return;
  }

  const name = requireStringOption(parsed.options, "name");
  const normalizedPath = await realpath(
    path.resolve(requireStringOption(parsed.options, "path")),
  );
  const existing = (await client.listProjects()).find(
    (project) => project.path === normalizedPath,
  );
  const project =
    existing ?? (await client.createProject({ name, path: normalizedPath }));

  writeOutput(io.stdout, mode, project);
}
