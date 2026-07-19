import type {
  CandidateAsset,
  EvolutionScopePolicy,
  RuntimeTraceEvent,
  RuntimeTraceSummary,
} from "@runweave/shared/evolution";

export type EvolutionWorkerCommand =
  | { id: number; op: "list-candidates" }
  | { id: number; op: "put-candidate"; candidate: CandidateAsset }
  | { id: number; op: "get-policy"; learningScopeId: string }
  | { id: number; op: "put-policy"; policy: EvolutionScopePolicy }
  | { id: number; op: "put-trace"; trace: RuntimeTraceSummary }
  | { id: number; op: "append-trace-event"; event: RuntimeTraceEvent }
  | { id: number; op: "get-trace"; traceId: string }
  | { id: number; op: "list-traces"; runId: string }
  | { id: number; op: "integrity" }
  | { id: number; op: "close" };

export type EvolutionWorkerRequest =
  EvolutionWorkerCommand extends infer Command
    ? Command extends { id: number }
      ? Omit<Command, "id">
      : never
    : never;

export type EvolutionWorkerResult =
  | CandidateAsset[]
  | EvolutionScopePolicy
  | RuntimeTraceSummary
  | RuntimeTraceSummary[]
  | boolean
  | null;

export type EvolutionWorkerResponse =
  | { id: number; ok: true; result: EvolutionWorkerResult }
  | { id: number; ok: false; error: string };
