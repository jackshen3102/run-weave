import { createHash, randomUUID } from "node:crypto";
import type {
  CandidateAsset,
  EvolutionContextResult,
  EvolutionMemoryQuery,
  RuntimeTraceEvent,
  RuntimeTraceSummary,
} from "@runweave/shared/evolution";
import type { EvolutionActivationStore } from "../activation-store";
import { defaultEvolutionScopePolicy } from "../knowledge/lifecycle";
import {
  hardFilterMemoryCandidates,
  type EvolutionMemorySelector,
} from "../knowledge/retrieval";

export interface EvolutionMemoryProvider {
  prepare(query: EvolutionMemoryQuery): Promise<EvolutionContextResult>;
}

const encoder = new TextEncoder();

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeEvent(
  traceId: string,
  kind: RuntimeTraceEvent["kind"],
  detail: Record<string, unknown>,
  at: string,
): RuntimeTraceEvent {
  return { eventId: randomUUID(), traceId, kind, at, detail };
}

function escapeContextValue(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatCandidate(candidate: CandidateAsset, reason: string): string {
  return [
    `- assetId: ${candidate.assetId}`,
    `  revisionId: ${candidate.revisionId}`,
    `  status: ${candidate.lifecycle}`,
    `  reason: ${escapeContextValue(reason)}`,
    `  evidenceGrade: ${candidate.evidenceGrade}`,
    `  guidance: ${escapeContextValue(candidate.guidance)}`,
  ].join("\n");
}

function buildContext(
  candidates: CandidateAsset[],
  reasons: Map<string, string>,
): string {
  return [
    '<evolution-context status="canary" advisory="true">',
    ...candidates.map((candidate) =>
      formatCandidate(
        candidate,
        reasons.get(candidate.revisionId) ?? "selected",
      ),
    ),
    "</evolution-context>",
  ].join("\n");
}

function assignment(
  query: EvolutionMemoryQuery,
  assetId: string,
  policyRevision: number,
): { hash: string; ratio: number } {
  const hash = digest(
    [query.learningScopeId, query.runId, assetId, policyRevision].join("\n"),
  );
  return {
    hash,
    ratio: Number.parseInt(hash.slice(0, 13), 16) / 0x1fffffffffffff,
  };
}

export class DefaultEvolutionMemoryProvider implements EvolutionMemoryProvider {
  constructor(
    private readonly store: EvolutionActivationStore,
    private readonly selector: EvolutionMemorySelector,
  ) {}

  async prepare(query: EvolutionMemoryQuery): Promise<EvolutionContextResult> {
    const now = new Date().toISOString();
    const traceId = randomUUID();
    let trace: RuntimeTraceSummary = {
      traceId,
      learningScopeId: query.learningScopeId,
      runId: query.runId,
      dispatchId: query.dispatchId,
      workerRole: query.workerRole,
      taskDigest: digest(`${query.task}\n${query.intent}`),
      policyRevision: 0,
      selectorVersion: this.selector.version,
      assignmentBucket: "not_eligible",
      assignmentHash: null,
      assignments: [],
      retrievedRevisionIds: [],
      filtered: [],
      decisions: [],
      exposedRevisionIds: [],
      failOpenReason: null,
      createdAt: now,
      events: [],
    };
    try {
      const policy =
        (await this.store.getPolicy(query.learningScopeId)) ??
        defaultEvolutionScopePolicy(query.learningScopeId, now);
      trace.policyRevision = policy.revision;
      if (query.workerRole !== "code") {
        await this.store.putRuntimeTrace(trace);
        return { context: null, trace };
      }
      if (!policy.memoryCanaryEnabled || policy.canaryRate <= 0) {
        trace.assignmentBucket = "disabled";
        trace.events.push(
          makeEvent(traceId, "assigned", { bucket: "disabled" }, now),
        );
        await this.store.putRuntimeTrace(trace);
        return { context: null, trace };
      }
      const allCandidates = await this.store.listCandidates();
      trace.retrievedRevisionIds = allCandidates.map(
        (candidate) => candidate.revisionId,
      );
      trace.events.push(
        makeEvent(
          traceId,
          "retrieved",
          { revisionIds: trace.retrievedRevisionIds },
          now,
        ),
      );
      const filtered = hardFilterMemoryCandidates(allCandidates, query, policy);
      trace.filtered = filtered.filtered;
      trace.events.push(
        makeEvent(traceId, "filtered", { excluded: trace.filtered }, now),
      );
      trace.decisions = await this.selector.select(query, filtered.eligible);
      trace.events.push(
        makeEvent(traceId, "selected", { decisions: trace.decisions }, now),
      );
      const candidatesByRevision = new Map(
        filtered.eligible.map((candidate) => [candidate.revisionId, candidate]),
      );
      const selected: CandidateAsset[] = [];
      const reasons = new Map<string, string>();
      for (const decision of trace.decisions) {
        if (!decision.selected || decision.confidence < 0.7) continue;
        const candidate = candidatesByRevision.get(decision.revisionId);
        if (!candidate) continue;
        selected.push(candidate);
        reasons.set(candidate.revisionId, decision.reason);
      }
      trace.assignments = selected.map((candidate) => {
        const assigned = assignment(query, candidate.assetId, policy.revision);
        return {
          assetId: candidate.assetId,
          revisionId: candidate.revisionId,
          bucket:
            assigned.ratio < policy.canaryRate
              ? ("canary" as const)
              : ("control" as const),
          assignmentHash: assigned.hash,
        };
      });
      trace.assignmentHash =
        trace.assignments.length === 1
          ? (trace.assignments[0]?.assignmentHash ?? null)
          : null;
      trace.assignmentBucket = trace.assignments.some(
        (item) => item.bucket === "canary",
      )
        ? "canary"
        : "control";
      trace.events.push(
        makeEvent(traceId, "assigned", { assignments: trace.assignments }, now),
      );
      const canaryRevisionIds = new Set(
        trace.assignments
          .filter((item) => item.bucket === "canary")
          .map((item) => item.revisionId),
      );
      const exposed: CandidateAsset[] = [];
      for (const candidate of selected) {
        if (
          !canaryRevisionIds.has(candidate.revisionId) ||
          exposed.length >= policy.maxInjectedAssets
        ) {
          continue;
        }
        const proposed = [...exposed, candidate];
        if (
          encoder.encode(buildContext(proposed, reasons)).byteLength >
          policy.maxInjectionBytes
        ) {
          continue;
        }
        exposed.push(candidate);
      }
      const context =
        exposed.length > 0 ? buildContext(exposed, reasons) : null;
      if (context) {
        trace.exposedRevisionIds = exposed.map(
          (candidate) => candidate.revisionId,
        );
        trace.events.push(
          makeEvent(
            traceId,
            "exposed",
            { revisionIds: trace.exposedRevisionIds },
            now,
          ),
        );
      }
      await this.store.putRuntimeTrace(trace);
      return { context, trace };
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : "evolution_memory_provider_failed";
      trace = {
        ...trace,
        assignmentBucket: "control",
        failOpenReason: reason,
        events: [
          ...trace.events,
          makeEvent(traceId, "fail_open", { reason }, now),
        ],
      };
      await this.store.putRuntimeTrace(trace).catch(() => undefined);
      return { context: null, trace };
    }
  }
}
