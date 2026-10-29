import { runBrowserHeadersCommand } from "./browser-headers.js";
import { runBrowserProxyCommand } from "./browser-proxy.js";
import { runBrowserDownloadsCommand } from "./browser-downloads.js";
import { CliError } from "../errors.js";
import { runBrowserAssistCommand } from "./browser-assist.js";
import { runBrowserToolsCommand } from "./browser-tools.js";
import {
  resolveBrowserProfile,
  type BrowserCommandIo,
} from "./browser-profile.js";

const USAGE =
  "Usage: rw browser profile resolve [--profile 1|2|3] [--group-id <id>] [--json] | rw browser proxy <status|set> [options] | rw browser headers <list|set|remove> [options] | rw browser downloads <capture|release|list|fetch> [options] | rw browser tools <list|call> [options] | rw browser assist <request|status|acknowledge|cancel> [options]";

export async function runBrowserCommand(
  subcommand: string | undefined,
  args: string[],
  io: BrowserCommandIo,
): Promise<void> {
  if (subcommand === "proxy") {
    await runBrowserProxyCommand(args, io);
    return;
  }
  if (subcommand === "downloads") {
    await runBrowserDownloadsCommand(args, io);
    return;
  }
  if (subcommand === "headers") {
    await runBrowserHeadersCommand(args, io);
    return;
  }
  if (subcommand === "tools") {
    await runBrowserToolsCommand(args, io);
    return;
  }
  if (subcommand === "assist") {
    await runBrowserAssistCommand(args, io);
    return;
  }
  if (subcommand !== "profile" || args[0] !== "resolve") {
    throw new CliError(USAGE, 2);
  }
  const result = await resolveBrowserProfile(args.slice(1), io);
  io.stdout.write(
    args.includes("--json")
      ? `${JSON.stringify(result, null, 2)}\n`
      : `${result.cdpEndpoint}\n`,
  );
}
