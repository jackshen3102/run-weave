import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  CreateQualityIssueHandoffRequest,
  CreateQualityIssueHandoffResponse,
  QualityCapabilities,
  QualityContextPage,
  QualityContextRequest,
  QualityCoverage,
  QualityIssueHandoffTargetAgent,
  QualityLatencyBaselinesResponse,
  QualityLedger,
  QualityLedgerCommit,
  QualityPage,
} from "@runweave/shared/quality-workflow";
import { getStringOption, parseArgs, resolveOutputMode, requireStringOption } from "../args.js";
import { resolveAuthContext } from "../client/auth-context.js";
import { CliError } from "../errors.js";
import { writeOutput } from "../output/format.js";

const QUALITY_USAGE =
  "Usage: rw quality <capabilities|events|context --file request.json|coverage|latency|ledger get|ledger commit --file request.json|ledger mark-fixed ...|handoff <issueId> ...> [--profile NAME] --json";
const HANDOFF_AGENTS = new Set<QualityIssueHandoffTargetAgent>(["codex", "claude", "pi", "traex", "agy"]);

export async function runQualityCommand(command: string | undefined, args: string[], io: { stdout: Pick<NodeJS.WriteStream, "write">; env: NodeJS.ProcessEnv }) {
  const parsed = parseArgs(args, new Set(["json", "plain", "submit", "allow-hypothesis"]));
  const sub = parsed.positionals[0];
  const commandAllowed = command === "events" ? ["cursor", "limit"]
    : command === "context" ? ["file"]
    : command === "ledger" && sub === "get" ? ["issue-id"]
    : command === "ledger" && sub === "commit" ? ["file"]
    : command === "ledger" && sub === "mark-fixed" ? ["issue-id", "fix-version", "summary", "expected-revision", "next-review-at", "run-key", "commit-key", "backend-id"]
    : command === "handoff" ? ["project-id", "agent", "operation-id", "prompt", "submit", "allow-hypothesis"]
    : [];
  const allowed = new Set(["json", "plain", "profile", "backend-port", "instance", "config-dir", ...commandAllowed]);
  for (const key of Object.keys(parsed.options)) if (!allowed.has(key)) throw new CliError(`Unknown quality option --${key}`, 2);
  const validShape =
    (["capabilities", "events", "context", "coverage", "latency"].includes(command ?? "") && parsed.positionals.length === 0) ||
    (command === "ledger" && parsed.positionals.length === 1 && ["get", "commit", "mark-fixed"].includes(sub ?? "")) ||
    (command === "handoff" && parsed.positionals.length === 1 && Boolean(sub));
  if (!validShape) throw new CliError(QUALITY_USAGE, 2);

  const auth = await resolveAuthContext({ profileName: getStringOption(parsed.options, "profile"), backendPort: getStringOption(parsed.options, "backend-port"), env: io.env });
  let result: unknown;
  if (command === "ledger" && sub === "commit") {
    const raw = await readFile(requireStringOption(parsed.options, "file"), "utf8");
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new CliError("Ledger request exceeds 2 MiB", 2);
    let request: QualityLedgerCommit;
    try { request = JSON.parse(raw) as QualityLedgerCommit; } catch { throw new CliError("Invalid request JSON", 2); }
    result = await auth.requestJson<{ revision: number; replayed: boolean }>("/api/quality-workflow/ledger/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
  } else if (command === "ledger" && sub === "mark-fixed") {
    const rawIds = requireStringOption(parsed.options, "issue-id").split(",").map(item => item.trim()).filter(Boolean);
    if (!rawIds.length || rawIds.length > 20) throw new CliError("--issue-id must list 1..20 issue IDs", 2);
    const fixVersion = requireStringOption(parsed.options, "fix-version");
    const summary = requireStringOption(parsed.options, "summary");
    const revRaw = requireStringOption(parsed.options, "expected-revision");
    if (!/^\d+$/.test(revRaw)) throw new CliError("--expected-revision must be a non-negative integer", 2);
    const expectedRevision = Number(revRaw);
    let backendId = getStringOption(parsed.options, "backend-id") ?? null;
    if (!backendId) {
      const cap = await auth.requestJson<QualityCapabilities>("/api/quality-workflow/capabilities");
      if (!cap.enabled || !cap.backendId) throw new CliError("Quality workflow is disabled on target backend", 1);
      backendId = cap.backendId;
    }
    const runKey = getStringOption(parsed.options, "run-key") ?? randomUUID();
    const commitKey = getStringOption(parsed.options, "commit-key") ?? `mark-fixed-${expectedRevision}`;
    const nextReviewAt = getStringOption(parsed.options, "next-review-at");
    const request: QualityLedgerCommit = {
      schemaVersion: 1, backendId, runKey, commitKey, expectedRevision, phase: "mark_fixed",
      fixedIssueIds: rawIds, fixVersion, summary, ...(nextReviewAt ? { nextReviewAt } : {}),
    };
    result = await auth.requestJson<{ revision: number; replayed: boolean }>("/api/quality-workflow/ledger/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
  } else if (command === "handoff") {
    const targetProjectId = requireStringOption(parsed.options, "project-id");
    const agentRaw = requireStringOption(parsed.options, "agent") as QualityIssueHandoffTargetAgent;
    if (!HANDOFF_AGENTS.has(agentRaw)) throw new CliError("--agent must be codex|claude|pi|traex|agy", 2);
    const operationId = requireStringOption(parsed.options, "operation-id");
    const prompt = getStringOption(parsed.options, "prompt");
    const request: CreateQualityIssueHandoffRequest = {
      operationId, targetProjectId, targetAgent: agentRaw,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(parsed.options.submit === true ? { submitPrompt: true } : {}),
      ...(parsed.options["allow-hypothesis"] === true ? { allowHypothesis: true } : {}),
    };
    result = await auth.requestJson<CreateQualityIssueHandoffResponse>(`/api/quality-workflow/issues/${encodeURIComponent(sub!)}/handoff`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
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
    const id = getStringOption(parsed.options, "issue-id"); result = await auth.requestJson<QualityLedger>(`/api/quality-workflow/ledger${id ? `?issueId=${encodeURIComponent(id)}` : ""}`);
  } else if (command === "coverage") result = await auth.requestJson<QualityCoverage>("/api/quality-workflow/coverage");
  else if (command === "latency") result = await auth.requestJson<QualityLatencyBaselinesResponse>("/api/quality-workflow/latency-baselines");
  else result = await auth.requestJson<QualityCapabilities>("/api/quality-workflow/capabilities");
  writeOutput(io.stdout, resolveOutputMode(parsed.options), result);
}
