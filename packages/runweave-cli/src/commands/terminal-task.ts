import { getBooleanOption, getStringOption, requireStringOption, type ParsedArgs } from "../args.js";
import { CliError } from "../errors.js";
import type { TerminalHttpClient } from "../client/terminal-http-client.js";
import type { TerminalTaskObservation } from "@runweave/shared/terminal/task";

export async function runTerminalTaskCommand(
  client: TerminalHttpClient, parsed: ParsedArgs, readText: () => Promise<string>,
): Promise<unknown> {
  const [action, id] = parsed.positionals;
  const option = (name: string) => getStringOption(parsed.options, name);
  const required = (name: string) => requireStringOption(parsed.options, name);
  const revision = () => {
    const value = Number(required("revision"));
    if (!Number.isSafeInteger(value) || value < 0) throw new CliError("--revision must be a non-negative integer", 2);
    return value;
  };
  if (action === "list") return client.listTasks();
  if (!id) throw new CliError("Usage: rw terminal task <create|start|observe|wait|send|control|review|interrupt> <taskId>", 2);
  if (action === "create") return client.createTask({ taskId: id, projectId: required("project-id"), cwd: required("cwd"), goal: required("goal") });
  if (action === "observe") return client.observeTask(id, option("after-turn"));
  if (action === "start" || action === "wait") {
    const waitMs = Number(option("wait-ms") ?? (action === "start" ? "120000" : "30000"));
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 120000) throw new CliError("--wait-ms must be between 0 and 120000", 2);
    if (action === "start") await client.startTask(id, { expectedRevision: revision(), commandLine: option("agent-start-command") });
    const deadline = Date.now() + waitMs;
    const cursor = action === "wait" ? required("cursor") : undefined;
    let observation: TerminalTaskObservation;
    do {
      observation = await client.observeTask(id, option("after-turn"));
      const done = action === "start"
        ? observation.task.phase === "ready" || observation.task.phase === "unavailable" || observation.availability === "target_changed" || observation.task.control === "human"
        : observation.cursor !== cursor;
      if (done) return { ...observation, waitTimedOut: false };
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
    } while (Date.now() <= deadline);
    return { ...observation!, waitTimedOut: true };
  }
  if (action === "send") {
    const delivery = option("delivery") ?? "when_idle";
    if (delivery !== "when_idle" && delivery !== "queue") throw new CliError("--delivery must be when_idle or queue", 2);
    return client.sendTask(id, { expectedRevision: revision(), dispatchId: required("dispatch-id"), text: await readText(), delivery });
  }
  if (action === "control") {
    const control = required("to");
    if (control !== "human" && control !== "supervisor") throw new CliError("--to must be human or supervisor", 2);
    return client.controlTask(id, { expectedRevision: revision(), control, draftCleared: getBooleanOption(parsed.options, "draft-cleared") });
  }
  if (action === "review") {
    const outcome = required("outcome");
    if (outcome !== "accepted" && outcome !== "changes_requested" && outcome !== "blocked") throw new CliError("Invalid review outcome", 2);
    let evidence: unknown;
    try { evidence = JSON.parse(required("evidence-json")); } catch { throw new CliError("--evidence-json must be a JSON string array", 2); }
    if (!Array.isArray(evidence) || !evidence.every((item) => typeof item === "string")) throw new CliError("--evidence-json must be a JSON string array", 2);
    return client.reviewTask(id, { expectedRevision: revision(), dispatchId: required("dispatch-id"), reviewId: required("review-id"), outcome, summary: required("summary"), evidence });
  }
  if (action === "interrupt") {
    if (required("scope") !== "terminal") throw new CliError("TUI interruption requires --scope terminal; exact turn cancellation is unsupported", 2);
    return client.interruptTask(id, { expectedRevision: revision(), scope: "terminal" });
  }
  throw new CliError(`Unknown terminal task command: ${action}`, 2);
}
