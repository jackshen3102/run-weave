import { readFileSync } from "node:fs";
import {
  normalizeTerminalBrowserHeaderRules,
  type TerminalBrowserHeaderState,
  type TerminalBrowserHeaderUpdate,
} from "@runweave/shared/terminal-browser-headers";
import { parseArgs, requireStringOption, getStringOption } from "../args.js";
import { CliError } from "../errors.js";
import { BrowserCdpClient } from "../client/browser-cdp.js";
import {
  resolveBrowserProfile,
  type BrowserCommandIo,
} from "./browser-profile.js";

export async function runBrowserHeadersCommand(
  args: string[],
  io: BrowserCommandIo,
): Promise<void> {
  const [command, ...rest] = args;
  if (command !== "list" && command !== "set" && command !== "remove") {
    throw new CliError(
      "Usage: rw browser headers <list|set|remove> [--id <id> --name <name> --value <value>|--value-file <path|-> --url-pattern <pattern>] [--disabled] [--profile 1|2|3] [--group-id <id>] [--show-values] [--json]",
      2,
    );
  }
  const { options, positionals } = parseArgs(
    rest,
    new Set(["json", "show-values", "disabled"]),
  );
  const allowed = new Set([
    "profile",
    "group-id",
    "json",
    "show-values",
    ...(command !== "list" ? ["id"] : []),
    ...(command === "set"
      ? ["name", "value", "value-file", "url-pattern", "disabled"]
      : []),
  ]);
  if (
    positionals.length ||
    Object.keys(options).some((key) => !allowed.has(key))
  ) {
    throw new CliError("Unexpected browser headers argument", 2);
  }
  const id =
    command === "list" ? undefined : requireStringOption(options, "id").trim();
  if (id === "") throw new CliError("--id cannot be blank", 2);
  let rule: TerminalBrowserHeaderState["rules"][number] | undefined;
  if (command === "set") {
    const valueFile = getStringOption(options, "value-file");
    const value = getStringOption(options, "value");
    if ((value === undefined) === (valueFile === undefined)) {
      throw new CliError(
        "Provide exactly one of --value or --value-file (use - for stdin)",
        2,
      );
    }
    const name = requireStringOption(options, "name");
    const urlPattern = requireStringOption(options, "url-pattern");
    try {
      [rule] = normalizeTerminalBrowserHeaderRules([
        {
          id,
          name,
          urlPattern,
          operation: "set",
          enabled: options.disabled !== true,
          // Permit the final newline typically produced by secret files/pipes.
          value:
            value ??
            readFileSync(valueFile === "-" ? 0 : valueFile!, "utf8").replace(
              /\r?\n$/,
              "",
            ),
        },
      ]);
    } catch (error) {
      throw new CliError(
        error instanceof Error ? error.message : "Invalid header rule",
        2,
      );
    }
  }
  const profileArgs = ["profile", "group-id"].flatMap((key) => {
    const value = getStringOption(options, key);
    return value ? [`--${key}`, value] : [];
  });
  const resolved = await resolveBrowserProfile(profileArgs, io);
  const cdp = await BrowserCdpClient.connect(resolved.cdpEndpoint);
  try {
    let state = await cdp.send<TerminalBrowserHeaderState>(
      "Runweave.getHeaderRules",
    );
    if (!state.revision || !Array.isArray(state.rules)) {
      throw new CliError(
        "This desktop does not provide Browser Header control; update the desktop",
        3,
      );
    }
    if (command !== "list") {
      const update: TerminalBrowserHeaderUpdate = rule
        ? { operation: "set", rule, expectedRevision: state.revision }
        : { operation: "remove", id: id!, expectedRevision: state.revision };
      state = await cdp.send<TerminalBrowserHeaderState>(
        "Runweave.updateHeaderRule",
        update,
      );
    }
    io.stdout.write(
      `${JSON.stringify(
        {
          ...state,
          profileId: resolved.profileId,
          scope: "profile",
          appliesTo: "future-requests",
          valuesRedacted: options["show-values"] !== true,
          rules: state.rules.map((saved) => ({
            ...saved,
            value: options["show-values"] === true ? saved.value : "[REDACTED]",
          })),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    cdp.close();
  }
}
