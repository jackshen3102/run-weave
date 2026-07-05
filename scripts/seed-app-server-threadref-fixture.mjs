#!/usr/bin/env node
import {
  discoverAppServerFromEnv,
  seedThreadRefFixture,
} from "./lib/app-server-threadref-fixture.mjs";

const options = parseArgs(process.argv.slice(2));
const required = ["project-id", "terminal-session-id"];
for (const name of required) {
  if (!options[name]) {
    fail(`Missing required option --${name}`);
  }
}

const statuses = (options.statuses ?? "running,starting")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
if (statuses.length === 0) {
  fail("--statuses must contain at least one status");
}

const context = await discoverAppServerFromEnv(process.env).catch((error) => {
  fail(
    `Could not discover App Server. Start it first or set RUNWEAVE_APP_SERVER_URL and RUNWEAVE_APP_SERVER_TOKEN. ${error instanceof Error ? error.message : String(error)}`,
  );
});

const result = await seedThreadRefFixture(context, {
  projectId: options["project-id"],
  terminalSessionId: options["terminal-session-id"],
  terminalPanelId: options["terminal-panel-id"] ?? null,
  runId: options["run-id"] ?? null,
  prefix: options.prefix ?? `threadref-fixture-${Date.now()}`,
  statuses,
  cwd: options.cwd ?? process.cwd(),
  agent: options.agent ?? "codex",
});

if (options["print-json"] === true) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(
    [
      `projectId=${result.projectId}`,
      `terminalSessionId=${result.terminalSessionId}`,
      ...result.threads.map(
        (thread) =>
          `${thread.status}: threadId=${thread.threadId} eventIds=${thread.eventIds.join(",")}`,
      ),
    ].join("\n") + "\n",
  );
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) {
      fail(`Unexpected positional argument: ${arg}`);
    }
    const equalIndex = arg.indexOf("=");
    const name = arg.slice(2, equalIndex > 0 ? equalIndex : undefined);
    if (!name) {
      fail(`Invalid option: ${arg}`);
    }
    if (name === "print-json") {
      parsed[name] = equalIndex > 0 ? arg.slice(equalIndex + 1) !== "false" : true;
      continue;
    }
    const value = equalIndex > 0 ? arg.slice(equalIndex + 1) : args[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for --${name}`);
    }
    parsed[name] = value;
    if (equalIndex < 0) {
      index += 1;
    }
  }
  return parsed;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
