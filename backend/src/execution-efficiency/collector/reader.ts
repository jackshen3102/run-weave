import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  EfficiencyCheckpoint,
  EfficiencyCoverage,
  EfficiencyDimension,
  EfficiencyMeasurement,
  EfficiencyObservation,
  TokenUsageSample,
} from "@runweave/shared/execution-efficiency";
import {
  isInside,
  listLogFiles,
  MAX_BATCH_BYTES,
  readSessionHeader,
  resolveCodexLogRoots,
  type LogCandidate,
} from "./log-files";
import {
  measureCallIntervals,
  measureStructuredElapsed,
  type TimedInterval,
} from "./duration";
import {
  EXECUTION_EFFICIENCY_POLICY_VERSION,
  screenMeasurement,
} from "./screening";
import {
  measureTokenWindows,
  parseUsageSample,
  type RawTokenUsage,
  type TokenWindow,
} from "./usage";

const MAX_BATCH_SESSIONS = 10;
const INITIAL_WINDOW_MS = 7 * 24 * 60 * 60_000;

export interface CollectedEfficiencyObservation {
  observation: EfficiencyObservation;
  admitted: boolean;
  admissionReason: string;
  title: string;
}

export interface ProjectCollectionResult {
  observations: CollectedEfficiencyObservation[];
  checkpoints: EfficiencyCheckpoint[];
  coverage: EfficiencyCoverage;
}

export interface ProjectCollectionInput {
  projectId: string;
  repositoryId: string;
  projectPaths: string[];
  logRoots?: string[];
  checkpoints: Map<string, EfficiencyCheckpoint>;
  excludedThreadIds?: Set<string>;
  now?: Date;
}

interface ParsedCall {
  callId: string;
  key: string;
  name: string;
  line: number;
  outputLine: number | null;
  startedAt: number | null;
  endedAt: number | null;
  beforeIndex: number;
  output: unknown;
  summary: string;
}

interface ParsedTurn {
  id: string;
  startLine: number;
  targetSeconds: number | null;
  model: string | null;
  serviceTier: string | null;
  samples: TokenUsageSample[];
  calls: ParsedCall[];
  callById: Map<string, ParsedCall>;
  evidence: string[];
}

export { resolveCodexLogRoots } from "./log-files";

export async function collectProjectEvidence(
  input: ProjectCollectionInput,
): Promise<ProjectCollectionResult> {
  const startedAt = performance.now();
  const coverage: EfficiencyCoverage = {
    sessionsInspected: 0,
    sessionsAccepted: 0,
    observationsCreated: 0,
    excluded: {},
    unknownReasons: [],
    bytesRead: 0,
    durationMs: 0,
    backlog: false,
  };
  const trustedPaths = await Promise.all(
    input.projectPaths.map((item) => realpath(item).catch(() => path.resolve(item))),
  );
  const roots = input.logRoots ?? resolveCodexLogRoots(process.env);
  const candidates = await listLogFiles(
    roots,
    (input.now ?? new Date()).getTime() - INITIAL_WINDOW_MS,
    coverage,
  );
  if (input.checkpoints.size === 0) candidates.reverse();
  const observations: CollectedEfficiencyObservation[] = [];
  const checkpoints: EfficiencyCheckpoint[] = [];
  let accepted = 0;
  for (const candidate of candidates) {
    if (accepted >= MAX_BATCH_SESSIONS) {
      coverage.backlog = true;
      break;
    }
    const header = await readSessionHeader(candidate.file);
    coverage.sessionsInspected += 1;
    if (!header) {
      increment(coverage.excluded, "invalid_session_identity");
      continue;
    }
    if (input.excludedThreadIds?.has(header.threadId)) {
      increment(coverage.excluded, "analysis_thread");
      continue;
    }
    const cwd = await realpath(header.cwd).catch(() => path.resolve(header.cwd));
    if (!trustedPaths.some((root) => isInside(root, cwd))) {
      increment(coverage.excluded, "outside_project");
      continue;
    }
    const previous = input.checkpoints.get(header.threadId);
    const unchanged =
      previous?.fileGeneration === candidate.generation &&
      previous.committedOffset === candidate.size;
    if (unchanged) {
      increment(coverage.excluded, "unchanged");
      continue;
    }
    const offset =
      previous?.fileGeneration === candidate.generation &&
      previous.committedOffset <= candidate.size
        ? previous.committedOffset
        : 0;
    const available = candidate.size - offset;
    if (available <= 0) continue;
    if (coverage.bytesRead + available > MAX_BATCH_BYTES) {
      coverage.backlog = true;
      break;
    }
    const result = await readCandidate({
      candidate,
      offset,
      baseLine: offset === 0 ? 0 : (previous?.lastCompleteEventLine ?? 0),
      baseline: offset === 0 ? null : (previous?.counterBaseline ?? null),
      projectId: input.projectId,
      repositoryId: input.repositoryId,
      threadId: header.threadId,
    });
    coverage.bytesRead += result.bytesRead;
    if (!result.completedTurn) {
      increment(coverage.excluded, "no_new_completed_turn");
      continue;
    }
    accepted += 1;
    coverage.sessionsAccepted += 1;
    observations.push(...result.observations);
    checkpoints.push(result.checkpoint);
    for (const warning of result.warnings) {
      if (!coverage.unknownReasons.includes(warning))
        coverage.unknownReasons.push(warning);
    }
  }
  coverage.observationsCreated = observations.length;
  coverage.durationMs = Math.round(performance.now() - startedAt);
  return { observations, checkpoints, coverage };
}

async function readCandidate(input: {
  candidate: LogCandidate;
  offset: number;
  baseLine: number;
  baseline: TokenUsageSample | null;
  projectId: string;
  repositoryId: string;
  threadId: string;
}): Promise<{
  bytesRead: number;
  completedTurn: boolean;
  observations: CollectedEfficiencyObservation[];
  checkpoint: EfficiencyCheckpoint;
  warnings: string[];
}> {
  const handle = await open(input.candidate.file, "r");
  let buffer: Buffer;
  try {
    buffer = Buffer.alloc(input.candidate.size - input.offset);
    const read = await handle.read(buffer, 0, buffer.length, input.offset);
    buffer = buffer.subarray(0, read.bytesRead);
  } finally {
    await handle.close();
  }
  const lastNewline = buffer.lastIndexOf(10);
  const complete = lastNewline < 0 ? Buffer.alloc(0) : buffer.subarray(0, lastNewline + 1);
  let cursor = 0;
  let line = input.baseLine;
  let committedOffset = input.offset;
  let committedLine = input.baseLine;
  let committedBaseline = input.baseline;
  let current: ParsedTurn | null = null;
  let globalUsage = input.baseline;
  let completedTurn = false;
  const observations: CollectedEfficiencyObservation[] = [];
  const warnings = new Set<string>();
  while (cursor < complete.length) {
    const newline = complete.indexOf(10, cursor);
    if (newline < 0) break;
    const raw = complete.subarray(cursor, newline).toString("utf8");
    const endOffset = input.offset + newline + 1;
    cursor = newline + 1;
    line += 1;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      warnings.add("存在无法解析的完整日志行，检查点停在上一完整轮次");
      continue;
    }
    const payload = object(record.payload);
    if (!payload) continue;
    const timestamp = string(record.timestamp) ?? new Date(0).toISOString();
    if (record.type === "turn_context" || isTaskStarted(record, payload)) {
      const turnId = string(payload.turn_id) ?? `turn-${line}`;
      current = createTurn(turnId, line, payload, globalUsage);
    }
    if (!current) continue;
    if (isUserMessage(record, payload)) {
      const text = messageText(payload);
      const target = /目标(?:为|是|[:：])?\s*(\d+(?:\.\d+)?)\s*秒/u.exec(text);
      if (target) current.targetSeconds = Number(target[1]);
      if (text) current.evidence.push(excerpt(text));
    }
    if (record.type === "event_msg" && payload.type === "token_count") {
      const info = object(payload.info);
      const sample = parseUsageSample(
        object(info?.total_token_usage) as RawTokenUsage | null,
        {
          line,
          observedAt: timestamp,
          model: current.model,
          serviceTier: current.serviceTier,
        },
      );
      if (sample) {
        if (!globalUsage || sample.total !== globalUsage.total) {
          current.samples.push(sample);
          globalUsage = sample;
        }
      } else {
        warnings.add("存在缺失或无效的 Token 累计采样");
      }
    }
    if (record.type === "response_item" && isCall(payload)) {
      const callId = string(payload.call_id);
      if (callId) {
        const rawArguments = payload.arguments ?? payload.input ?? "";
        const summary = excerpt(
          typeof rawArguments === "string"
            ? rawArguments
            : JSON.stringify(rawArguments),
          420,
        );
        const name = string(payload.name) ?? "tool";
        const call: ParsedCall = {
          callId,
          key: hash(`${name}\0${summary}`),
          name,
          line,
          outputLine: null,
          startedAt: parseTimestamp(timestamp),
          endedAt: null,
          beforeIndex: Math.max(0, current.samples.length - 1),
          output: null,
          summary,
        };
        current.calls.push(call);
        current.callById.set(callId, call);
      }
    }
    if (record.type === "response_item" && isCallOutput(payload)) {
      const call = current.callById.get(string(payload.call_id) ?? "");
      if (call) {
        call.outputLine = line;
        call.endedAt = parseTimestamp(timestamp);
        call.output = payload.output;
      }
    }
    if (isTurnFinished(record, payload)) {
      observations.push(
        ...buildTurnObservations({
          turn: current,
          projectId: input.projectId,
          repositoryId: input.repositoryId,
          threadId: input.threadId,
          sessionFile: path.basename(input.candidate.file),
          endedAt: timestamp,
          endLine: line,
        }),
      );
      committedOffset = endOffset;
      committedLine = line;
      committedBaseline = globalUsage;
      completedTurn = true;
      current = null;
    }
  }
  return {
    bytesRead: buffer.length,
    completedTurn,
    observations,
    checkpoint: {
      repositoryId: input.repositoryId,
      sessionId: input.threadId,
      fileGeneration: input.candidate.generation,
      committedOffset,
      lastCompleteEventLine: committedLine,
      counterBaseline: committedBaseline,
      pendingCalls: [],
      updatedAt: new Date().toISOString(),
    },
    warnings: [...warnings],
  };
}

function buildTurnObservations(input: {
  turn: ParsedTurn;
  projectId: string;
  repositoryId: string;
  threadId: string;
  sessionFile: string;
  endedAt: string;
  endLine: number;
}): CollectedEfficiencyObservation[] {
  const groups = new Map<string, ParsedCall[]>();
  for (const call of input.turn.calls) {
    const group = groups.get(call.key) ?? [];
    group.push(call);
    groups.set(call.key, group);
  }
  const collected: CollectedEfficiencyObservation[] = [];
  for (const calls of groups.values()) {
    const completeCalls = calls.filter(
      (call) => call.outputLine !== null && call.endedAt !== null,
    );
    if (!completeCalls.length) continue;
    const callName = completeCalls[0]!.name;
    const windows: TokenWindow[] = completeCalls.flatMap((call) => {
      const afterIndex = input.turn.samples.findIndex(
        (sample) => sample.line > call.outputLine!,
      );
      return afterIndex > call.beforeIndex
        ? [{ beforeIndex: call.beforeIndex, afterIndex, callIds: [call.callId] }]
        : [];
    });
    const tokenMeasurement = measureTokenWindows(
      input.turn.samples,
      windows,
      completeCalls.length,
    );
    if (tokenMeasurement && completeCalls.length >= 3) {
      collected.push(
        makeObservation(input, completeCalls, "tokens", tokenMeasurement, {
          title: `${completeCalls.length} 次 ${callName} 相关 Token 区间`,
          tool: callName,
        }),
      );
    }
    const intervals: TimedInterval[] = completeCalls.flatMap((call) =>
      call.startedAt !== null && call.endedAt !== null
        ? [{ startMs: call.startedAt, endMs: call.endedAt }]
        : [],
    );
    const durationMeasurement = measureCallIntervals(intervals);
    if (durationMeasurement && completeCalls.length >= 3) {
      collected.push(
        makeObservation(input, completeCalls, "duration", durationMeasurement, {
          title: `${completeCalls.length} 次 ${callName} 调用区间`,
          tool: callName,
        }),
      );
    }
    for (const call of completeCalls) {
      const structured = measureStructuredElapsed(
        call.output,
        input.turn.targetSeconds,
      );
      if (!structured) continue;
      collected.push(
        makeObservation(input, [call], "duration", structured, {
          title: `${callName} 到 shell 可用耗时 ${structured.seconds?.toFixed(3)} 秒`,
          tool: callName,
        }),
      );
    }
  }
  return collected;
}

function makeObservation(
  input: {
    turn: ParsedTurn;
    projectId: string;
    repositoryId: string;
    threadId: string;
    sessionFile: string;
    endedAt: string;
    endLine: number;
  },
  calls: ParsedCall[],
  dimension: EfficiencyDimension,
  measurement: EfficiencyMeasurement,
  presentation: { title: string; tool: string },
): CollectedEfficiencyObservation {
  const startLine = Math.min(...calls.map((call) => call.line));
  const endLine = Math.max(
    ...calls.map((call) => call.outputLine ?? call.line),
  );
  const evidence = calls
    .slice(0, 4)
    .map((call) => `${call.name}: ${call.summary}\n${excerpt(call.output, 600)}`)
    .join("\n\n");
  const sourceHash = hash(evidence);
  const observation: EfficiencyObservation = {
    id: hash(
      [
        input.repositoryId,
        input.threadId,
        input.turn.id,
        dimension,
        startLine,
        endLine,
        sourceHash,
      ].join("\0"),
    ),
    repositoryId: input.repositoryId,
    projectId: input.projectId,
    threadId: input.threadId,
    turnId: input.turn.id,
    dimension,
    sourceHash,
    sourceSpan: {
      sessionFile: input.sessionFile,
      startLine,
      endLine,
      excerpt: evidence,
    },
    measurement,
    conditions: {
      tool: presentation.tool,
      policyVersion: EXECUTION_EFFICIENCY_POLICY_VERSION,
    },
    quality: {
      completeness:
        dimension === "tokens" &&
        measurement.kind === "token-windows" &&
        [measurement.input, measurement.cachedInput, measurement.output].some(
          (value) => value === null,
        )
          ? "partial"
          : "complete",
      warnings: [],
    },
    observedAt: input.endedAt,
  };
  const screened = screenMeasurement(dimension, measurement);
  return {
    observation,
    admitted: screened.admitted,
    admissionReason: screened.reason,
    title: presentation.title,
  };
}

function createTurn(
  id: string,
  line: number,
  payload: Record<string, unknown>,
  baseline: TokenUsageSample | null,
): ParsedTurn {
  const model = string(payload.model) ?? string(object(payload.settings)?.model);
  const serviceTier =
    string(payload.service_tier) ?? string(object(payload.settings)?.service_tier);
  return {
    id,
    startLine: line,
    targetSeconds: null,
    model,
    serviceTier,
    samples: baseline ? [baseline] : [],
    calls: [],
    callById: new Map(),
    evidence: [],
  };
}

function isTaskStarted(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
): boolean {
  return record.type === "event_msg" && payload.type === "task_started";
}

function isTurnFinished(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
): boolean {
  return (
    record.type === "event_msg" &&
    (payload.type === "task_complete" || payload.type === "turn_aborted")
  );
}

function isUserMessage(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
): boolean {
  return (
    record.type === "response_item" &&
    payload.type === "message" &&
    payload.role === "user"
  );
}

function isCall(payload: Record<string, unknown>): boolean {
  return payload.type === "function_call" || payload.type === "custom_tool_call";
}

function isCallOutput(payload: Record<string, unknown>): boolean {
  return (
    payload.type === "function_call_output" ||
    payload.type === "custom_tool_call_output"
  );
}

function messageText(payload: Record<string, unknown>): string {
  return Array.isArray(payload.content)
    ? payload.content
        .map((item) => string(object(item)?.text) ?? "")
        .filter(Boolean)
        .join("\n")
    : "";
}

function excerpt(value: unknown, limit = 1_800): string {
  const text = redact(
    typeof value === "string" ? value : JSON.stringify(value ?? ""),
  );
  return text.length > limit ? `${text.slice(0, limit)}… [截断]` : text;
}

function redact(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex -- ANSI terminal escape sequences are untrusted evidence formatting.
    .replace(/\u001b\[[0-9;]*m/gu, "")
    .replace(/\bBearer\s+[\w.+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk-[\w-]{12,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/gu, "[REDACTED]")
    .replace(
      /((?:password|passwd|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|token)["']?\s*[:=]\s*["']?)[^\s"',;}]+/giu,
      "$1[REDACTED]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[REDACTED]@");
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parseTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}
