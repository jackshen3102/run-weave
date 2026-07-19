import type {
  CandidateAsset,
  EvolutionScopePolicy,
  RuntimeTraceEvent,
  RuntimeTraceSummary,
} from "@runweave/shared/evolution";

export interface EvolutionActivationStore {
  listCandidates(): Promise<CandidateAsset[]>;
  putCandidate(candidate: CandidateAsset): Promise<void>;
  getPolicy(learningScopeId: string): Promise<EvolutionScopePolicy | null>;
  putPolicy(policy: EvolutionScopePolicy): Promise<void>;
  putRuntimeTrace(trace: RuntimeTraceSummary): Promise<void>;
  appendRuntimeTraceEvent(
    traceId: string,
    event: RuntimeTraceEvent,
  ): Promise<void>;
  getRuntimeTrace(traceId: string): Promise<RuntimeTraceSummary | null>;
  listRuntimeTraces(runId: string): Promise<RuntimeTraceSummary[]>;
  close(): Promise<void>;
}

export class InMemoryEvolutionActivationStore implements EvolutionActivationStore {
  private readonly candidates = new Map<string, CandidateAsset>();
  private readonly policies = new Map<string, EvolutionScopePolicy>();
  private readonly traces = new Map<string, RuntimeTraceSummary>();

  async listCandidates(): Promise<CandidateAsset[]> {
    return Array.from(this.candidates.values(), (candidate) => ({
      ...candidate,
    }));
  }

  async putCandidate(candidate: CandidateAsset): Promise<void> {
    const current = this.candidates.get(candidate.assetId);
    if (!current || current.updatedAt <= candidate.updatedAt) {
      this.candidates.set(candidate.assetId, { ...candidate });
    }
  }

  async getPolicy(
    learningScopeId: string,
  ): Promise<EvolutionScopePolicy | null> {
    const policy = this.policies.get(learningScopeId);
    return policy ? { ...policy } : null;
  }

  async putPolicy(policy: EvolutionScopePolicy): Promise<void> {
    const current = this.policies.get(policy.learningScopeId);
    if (current && current.revision >= policy.revision) {
      throw new Error("evolution_policy_revision_conflict");
    }
    this.policies.set(policy.learningScopeId, { ...policy });
  }

  async putRuntimeTrace(trace: RuntimeTraceSummary): Promise<void> {
    this.traces.set(trace.traceId, {
      ...trace,
      events: [...trace.events],
    });
  }

  async appendRuntimeTraceEvent(
    traceId: string,
    event: RuntimeTraceEvent,
  ): Promise<void> {
    const trace = this.traces.get(traceId);
    if (!trace) {
      throw new Error("runtime_trace_not_found");
    }
    trace.events.push({ ...event });
  }

  async getRuntimeTrace(traceId: string): Promise<RuntimeTraceSummary | null> {
    const trace = this.traces.get(traceId);
    return trace ? { ...trace, events: [...trace.events] } : null;
  }

  async listRuntimeTraces(runId: string): Promise<RuntimeTraceSummary[]> {
    return Array.from(this.traces.values())
      .filter((trace) => trace.runId === runId)
      .map((trace) => ({ ...trace, events: [...trace.events] }));
  }

  async close(): Promise<void> {}
}
