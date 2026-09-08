import type {
  BrowserToolList,
  BrowserToolResult,
} from "@runweave/shared/terminal-browser-webmcp";
import { parseArgs, requireStringOption, getStringOption } from "../args.js";
import { CliError } from "../errors.js";
import { BrowserCdpClient } from "../client/browser-cdp.js";
import {
  resolveBrowserProfile,
  type BrowserCommandIo,
} from "./browser-profile.js";

interface TargetInfo {
  targetId: string;
  title: string;
  url: string;
}

export async function runBrowserToolsCommand(
  args: string[],
  io: BrowserCommandIo,
): Promise<void> {
  const [command, ...rest] = args;
  if (command !== "list" && command !== "call") {
    throw new CliError(
      "Usage: rw browser tools <list|call> [--target-id <id>] [--tool-id <id> --arguments <json>] [--profile 1|2|3] [--group-id <id>] [--json]",
      2,
    );
  }
  const { options, positionals } = parseArgs(rest, new Set(["json"]));
  const allowed = new Set([
    "target-id",
    "profile",
    "group-id",
    "json",
    ...(command === "call" ? ["tool-id", "arguments"] : []),
  ]);
  if (
    positionals.length ||
    Object.keys(options).some((key) => !allowed.has(key))
  ) {
    throw new CliError("Unexpected browser tools argument", 2);
  }
  const targetId =
    command === "call"
      ? requireStringOption(options, "target-id")
      : getStringOption(options, "target-id");
  let call: { toolId: string; arguments: Record<string, unknown> } | undefined;
  if (command === "call") {
    const toolId = requireStringOption(options, "tool-id");
    let input: unknown;
    try {
      input = JSON.parse(requireStringOption(options, "arguments"));
    } catch {
      throw new CliError("--arguments must be a JSON object", 2);
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new CliError("--arguments must be a JSON object", 2);
    }
    call = { toolId, arguments: input as Record<string, unknown> };
  }
  const profileArgs = ["profile", "group-id"].flatMap((key) => {
    const value = getStringOption(options, key);
    return value ? [`--${key}`, value] : [];
  });
  const resolved = await resolveBrowserProfile(profileArgs, io);
  const cdp = await BrowserCdpClient.connect(resolved.cdpEndpoint);
  try {
    const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>(
      "Target.getTargets",
    );
    const targets = targetId
      ? targetInfos.filter((target) => target.targetId === targetId)
      : targetInfos;
    if (targetId && !targets.length)
      throw new CliError(
        "Target is outside the resolved Profile/Group or closed",
        4,
      );
    const results = [];
    for (const target of targets) {
      const { sessionId } = await cdp.send<{ sessionId: string }>(
        "Target.attachToTarget",
        { targetId: target.targetId, flatten: true },
      );
      const result = await cdp.send<
        BrowserToolResult<BrowserToolList | { output: string }>
      >(
        call ? "Runweave.callBrowserTool" : "Runweave.listBrowserTools",
        call ?? {},
        sessionId,
      );
      results.push({ ...target, ...result });
    }
    io.stdout.write(`${JSON.stringify({ targets: results }, null, 2)}\n`);
    const failure = results.find((result) => !result.ok);
    if (failure && !failure.ok) {
      throw new CliError(
        `${failure.error.code}: ${failure.error.message} (execution: ${failure.error.execution})`,
        failure.error.code === "INVALID_ARGUMENTS" ? 2 : 4,
      );
    }
  } finally {
    cdp.close();
  }
}
