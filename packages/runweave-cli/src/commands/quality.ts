import { readFile } from "node:fs/promises";
import type { QualityCapabilities, QualityContextRequest, QualityContextPage, QualityCoverage, QualityLedger, QualityLedgerCommit, QualityPage } from "@runweave/shared/quality-workflow";
import { getStringOption, parseArgs, resolveOutputMode, requireStringOption } from "../args.js";
import { resolveAuthContext } from "../client/auth-context.js";
import { CliError } from "../errors.js";
import { writeOutput } from "../output/format.js";
export async function runQualityCommand(command: string | undefined, args: string[], io: { stdout: Pick<NodeJS.WriteStream, "write">; env: NodeJS.ProcessEnv }) {
  const parsed = parseArgs(args, new Set(["json", "plain"]));
  const allowed = new Set(["json", "plain", "profile", "backend-port", "instance", "config-dir", ...(command === "events" ? ["cursor", "limit"] : command === "ledger" ? ["file", "issue-id"] : command === "context" ? ["file"] : [])]);
  for (const key of Object.keys(parsed.options)) if (!allowed.has(key)) throw new CliError(`Unknown quality option --${key}`, 2);
  if (!["capabilities", "events", "context", "coverage", "ledger"].includes(command ?? "") || (command !== "ledger" && parsed.positionals.length) || (command === "ledger" && (parsed.positionals.length !== 1 || !["get", "commit"].includes(parsed.positionals[0]!)))) throw new CliError("Usage: rw quality <capabilities|events|context --file request.json|coverage|ledger get|ledger commit --file request.json> [--profile NAME] --json", 2);
  const auth = await resolveAuthContext({ profileName: getStringOption(parsed.options, "profile"), backendPort: getStringOption(parsed.options, "backend-port"), env: io.env });
  let result: unknown;
  if (command === "ledger" && parsed.positionals[0] === "commit") {
    if (parsed.options["issue-id"] !== undefined) throw new CliError("--issue-id is only valid for ledger get", 2);
    const raw = await readFile(requireStringOption(parsed.options, "file"), "utf8");
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new CliError("Ledger request exceeds 2 MiB", 2);
    let request: QualityLedgerCommit;
    try { request = JSON.parse(raw) as QualityLedgerCommit; } catch { throw new CliError("Invalid request JSON", 2); }
    result = await auth.requestJson<{ revision: number; replayed: boolean }>("/api/quality-workflow/ledger/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
  } else if (command === "context") {
    const raw = await readFile(requireStringOption(parsed.options, "file"), "utf8");
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new CliError("Context request exceeds 1 MiB", 2);
    let request: QualityContextRequest;
    try { request = JSON.parse(raw) as QualityContextRequest; } catch { throw new CliError("Invalid request JSON", 2); }
    result = await auth.requestJson<QualityContextPage>("/api/quality-workflow/events/context", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
  } else if (command === "events") {
    const limit = getStringOption(parsed.options, "limit") ?? "200";
    if (!/^[1-9]\d{0,3}$/.test(limit) || Number(limit) > 1000) throw new CliError("--limit must be 1..1000", 2);
    const query = new URLSearchParams({ limit }); const cursor = getStringOption(parsed.options, "cursor"); if (cursor) query.set("cursor", cursor);
    result = await auth.requestJson<QualityPage>(`/api/quality-workflow/events?${query}`);
  } else if (command === "ledger") {
    if (parsed.options.file !== undefined) throw new CliError("--file is only valid for ledger commit", 2);
    const id = getStringOption(parsed.options, "issue-id"); result = await auth.requestJson<QualityLedger>(`/api/quality-workflow/ledger${id ? `?issueId=${encodeURIComponent(id)}` : ""}`);
  } else if (command === "coverage") result = await auth.requestJson<QualityCoverage>("/api/quality-workflow/coverage");
  else result = await auth.requestJson<QualityCapabilities>("/api/quality-workflow/capabilities");
  writeOutput(io.stdout, resolveOutputMode(parsed.options), result);
}
