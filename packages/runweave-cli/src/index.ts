#!/usr/bin/env node
import { stdin, stdout, stderr } from "node:process";
import { runAppCommand } from "./commands/app.js";
import { runAuthCommand } from "./commands/auth.js";
import { runHealthCommand } from "./commands/health.js";
import { runProjectCommand } from "./commands/project.js";
import { runTerminalCommand } from "./commands/terminal.js";
import { toCliError } from "./errors.js";
import { readCliVersion } from "./version.js";

export async function runCli(
  argv: string[],
  io: {
    stdout: Pick<NodeJS.WriteStream, "write">;
    stderr: Pick<NodeJS.WriteStream, "write">;
    stdin: NodeJS.ReadStream;
    env: NodeJS.ProcessEnv;
  } = { stdout, stderr, stdin, env: process.env },
): Promise<number> {
  try {
    const [group, subcommand, ...args] = argv;
    if (group === "--version" || group === "-v") {
      io.stdout.write(`${readCliVersion().version}\n`);
      return 0;
    }
    if (group === "version") {
      const version = readCliVersion();
      if (subcommand === "--json" || args.includes("--json")) {
        io.stdout.write(`${JSON.stringify(version, null, 2)}\n`);
      } else {
        io.stdout.write(`${version.version}\n`);
      }
      return 0;
    }
    if (group === "auth") {
      await runAuthCommand(subcommand, args, io);
      return 0;
    }
    if (group === "health") {
      await runHealthCommand(
        [subcommand, ...args].filter((arg): arg is string => Boolean(arg)),
        io,
      );
      return 0;
    }
    if (group === "app") {
      await runAppCommand(subcommand, args, io);
      return 0;
    }
    if (group === "project") {
      await runProjectCommand(subcommand, args, io);
      return 0;
    }
    if (group === "terminal") {
      await runTerminalCommand(subcommand, args, io);
      return 0;
    }
    io.stderr.write(
      "Usage: rw [--version|version] | rw health [options] | rw <app|auth|project|terminal> <command> [options]\n",
    );
    return 2;
  } catch (error) {
    const cliError = toCliError(error);
    io.stderr.write(`${cliError.message}\n`);
    return cliError.exitCode;
  }
}

if (require.main === module) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
