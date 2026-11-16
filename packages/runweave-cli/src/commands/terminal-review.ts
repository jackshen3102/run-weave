import { getStringOption, requireStringOption, type ParsedArgs } from "../args.js";
import type { TerminalHttpClient } from "../client/terminal-http-client.js";
import { CliError } from "../errors.js";
import type { CodeReviewDetail } from "@runweave/shared/terminal/code-review";

/** Review scheduling, deduplication and delivery remain owned by Backend. */
export async function runTerminalReviewCommand(
  client: TerminalHttpClient, parsed: ParsedArgs, env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const [action, id, extra] = parsed.positionals;
  if (extra) throw new CliError("Unexpected argument; Review uses the source terminal's frozen requirements, not a positional prompt", 2);
  const allowedOptions = new Set(["json", "plain", "profile", "backend-port", "instance", "config-dir",
    ...(action === "start" ? ["request-id"] : action === "list" ? ["before"] : action === "wait" ? ["wait-ms"] : []),
  ]);
  for (const option of Object.keys(parsed.options)) {
    if (!allowedOptions.has(option)) throw new CliError(`Unsupported option --${option} for terminal review ${action ?? ""}`, 2);
  }
  if (action === "start" || action === "list") {
    const terminalId = id ?? env.RUNWEAVE_TERMINAL_SESSION_ID;
    if (!terminalId?.trim()) throw new CliError("Specify a source terminalSessionId or run inside a Runweave terminal (RUNWEAVE_TERMINAL_SESSION_ID)", 2);
    if (action === "list") return client.listCodeReviews(terminalId, getStringOption(parsed.options, "before"));
    const requestId = requireStringOption(parsed.options, "request-id");
    if (!requestId.trim() || requestId.length > 100) throw new CliError("--request-id must contain 1–100 characters", 2);
    return client.createCodeReview(terminalId, { requestId });
  }
  if ((action === "show" || action === "wait") && id) {
    if (action === "show") return client.getCodeReview(id);
    const waitMs = Number(getStringOption(parsed.options, "wait-ms") ?? "30000");
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 60000) throw new CliError("--wait-ms must be between 0 and 60000", 2);
    // Zero is a single observation, with no polling budget.
    if (waitMs === 0) {
      const detail = await client.getCodeReview(id);
      return { ...detail, waitTimedOut: ["preparing", "starting", "reviewing"].includes(detail.run.phase) };
    }
    const deadline = Date.now() + waitMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), waitMs);
    const observing = client.withSignal(controller.signal);
    let latest: CodeReviewDetail | undefined;
    try {
      while (Date.now() < deadline && !controller.signal.aborted) {
        latest = await observing.getCodeReview(id);
        if (Date.now() >= deadline || controller.signal.aborted) break;
        if (!["preparing", "starting", "reviewing"].includes(latest.run.phase)) return { ...latest, waitTimedOut: false };
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      clearTimeout(timer);
    }
    // Never invent a run when even the first response missed the deadline.
    return { ...(latest ?? { run: null, snapshot: null, report: null }), reviewId: id, waitTimedOut: true };
  }
  throw new CliError("Usage: rw terminal review <start [terminalSessionId] --request-id ID|list [terminalSessionId] [--before ID]|show <reviewId>|wait <reviewId> [--wait-ms 30000]>", 2);
}
