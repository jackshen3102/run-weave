#!/usr/bin/env node
import { withConfigurationArguments } from "@runweave/config-node";
import { stdin, stdout, stderr } from "node:process";
import { runAppServerCommand } from "./commands/app-server.js";
import { runAppCommand } from "./commands/app.js";
import { runAgentTeamCommand } from "./commands/agent-team.js";
import { runActivityCommand } from "./commands/activity.js";
import { runAuthCommand } from "./commands/auth.js";
import { runExperienceCommand } from "./commands/experience.js";
import { runEvolutionCommand } from "./commands/evolution.js";
import { runKnowledgeCommand } from "./commands/knowledge.js";
import { runHealthCommand } from "./commands/health.js";
import { runFeishuCommand } from "./commands/feishu.js";
import { runProjectCommand } from "./commands/project.js";
import { runTerminalCommand } from "./commands/terminal.js";
import { runBrowserCommand } from "./commands/browser.js";
import { runScheduledTaskCommand } from "./commands/scheduled-task.js";
import { toCliError } from "./errors.js";
import { readCliVersion } from "./version.js";
import { runConfigCommand } from "./commands/config.js";

export async function runCli(
  argv: string[],
  io: {
    stdout: Pick<NodeJS.WriteStream, "write">;
    stderr: Pick<NodeJS.WriteStream, "write">;
    stdin: NodeJS.ReadStream;
    env: NodeJS.ProcessEnv;
  } = { stdout, stderr, stdin, env: process.env },
): Promise<number> {
  return withConfigurationArguments(argv, async () => {
  try {
    const commandArgs: string[] = [];
    const contextArgs: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!;
      if (/^--(instance|config-dir)(=|$)/.test(arg)) {
        contextArgs.push(arg);
        if (!arg.includes("=") && argv[i + 1]) contextArgs.push(argv[++i]!);
      } else commandArgs.push(arg);
    }
    const [group, subcommand, ...tail] = commandArgs;
    const args = [...tail, ...contextArgs];
    if (group === "config") {
      await runConfigCommand(subcommand, args, io);
      return 0;
    }
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
    if (group === "feishu") {
      await runFeishuCommand(subcommand, args, io);
      return 0;
    }
    if (group === "app") {
      await runAppCommand(subcommand, args, io);
      return 0;
    }
    if (group === "app-server") {
      await runAppServerCommand(subcommand, args, io);
      return 0;
    }
    if (group === "agent-team") {
      await runAgentTeamCommand(subcommand, args, io);
      return 0;
    }
    if (group === "activity") {
      await runActivityCommand(subcommand, args, io);
      return 0;
    }
    if (group === "experience") {
      await runExperienceCommand(subcommand, args, io);
      return 0;
    }
    if (group === "knowledge") {
      await runKnowledgeCommand(subcommand, args, io);
      return 0;
    }
    if (group === "evolution") {
      await runEvolutionCommand(subcommand, args, io);
      return 0;
    }
    if (group === "project") {
      await runProjectCommand(subcommand, args, io);
      return 0;
    }
    if (group === "scheduled-task") {
      await runScheduledTaskCommand(subcommand, args, io);
      return 0;
    }
    if (group === "terminal") {
      await runTerminalCommand(subcommand, args, io);
      return 0;
    }
    if (group === "browser") {
      await runBrowserCommand(subcommand, args, io);
      return 0;
    }
    io.stderr.write(
      "Usage: rw [--version|version] | rw health [options] | rw <config|activity|agent-team|app|app-server|auth|browser|evolution|experience|knowledge|feishu|project|scheduled-task|terminal> <command> [options]\n",
    );
    return 2;
  } catch (error) {
    const cliError = toCliError(error);
    io.stderr.write(`${cliError.message}\n`);
    return cliError.exitCode;
  }
  });
}

if (require.main === module) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
