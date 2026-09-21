/** Local, curated experience for ordinary agent sessions. No Team dependency. */
export interface ExperienceEvidenceInput {
  path: string;
  startLine: number;
  endLine: number;
  note: string;
}
export interface ExperienceEvidence extends ExperienceEvidenceInput {
  sha256: string;
  /** Bounded, redacted excerpt retained independently of temporary source files. */
  archived?: { text: string; sha256: string };
}
export interface ExperienceDraft {
  id: string;
  title: string;
  /** Every group must match; synonyms within a group are alternatives. */
  triggers: string[][];
  avoid: string[];
  actions: string[];
  verification: string[];
  applicability: string;
  expiresAt: string;
  state: "active" | "retired" | "needs_revalidation";
  evidence: ExperienceEvidenceInput[];
  /** Optional navigation hints only; never read or hashed to determine availability. */
  codePaths?: string[];
}
export interface ExperienceRecord extends Omit<ExperienceDraft, "evidence"> {
  repositoryId: string;
  namespace: string;
  revision: string;
  updatedAt: string;
  evidence: ExperienceEvidence[];
  sourceJobId?: string;
}
export interface ExperienceView {
  record: ExperienceRecord;
  available: boolean;
  invalidReasons: string[];
}
export interface ExperienceSearchResult {
  lookupId: string;
  repositoryId: string;
  namespace: string;
  matches: Array<ExperienceView & { matchedTerms: string[] }>;
  excluded: Array<{ id: string; reasons: string[] }>;
}
export interface ExperienceDiagnostics {
  repositoryId: string;
  namespace: string;
  /** Saved observations, not a success rate or proof of benefit. */
  lookups: {
    total: number;
    withMatches: number;
    withFeedback: number;
    recent: Array<{
      query: string;
      at: string;
      matches: Array<{ id: string; revision: string }>;
      excluded: Array<{ id: string; reasons: string[] }>;
    }>;
  };
  feedback: { used: number; dismissed: number; attribution: "agent_report" };
  records: Array<{
    id: string;
    revision: string;
    title: string;
    available: boolean;
    invalidReasons: string[];
    /** Counts include all historical revisions of this record. */
    returned: number;
    used: number;
    dismissed: number;
    /** Present only for a diagnostic query; never creates a lookup. */
    queryMatch?: {
      matchedTerms: string[];
      missingGroups: string[][];
      outcome: "returned" | "ranked_out" | "excluded" | "trigger_mismatch";
    };
  }>;
}

export interface ExperienceFeedbackInput {
  lookupId: string;
  id: string;
  revision: string;
  task: string;
  decision: "used" | "dismissed";
  reason: string;
  action: string;
  outcome: string;
  result?: "succeeded" | "failed" | "unknown";
  evidence: ExperienceEvidenceInput[];
}
export interface ExperienceFeedback extends Omit<
  ExperienceFeedbackInput,
  "evidence"
> {
  feedbackId: string;
  repositoryId: string;
  namespace: string;
  recordedAt: string;
  /** A receipt is an agent report, never an automatically certified improvement. */
  attribution: "agent_report";
  evidence: ExperienceEvidence[];
}

export interface ExperienceCandidate {
  candidateId: string;
  evidenceIds: string[];
  sourceJobId: string;
  record: ExperienceRecord;
  expectedRevision: string | null;
  status: "pending" | "promoted" | "rejected";
  review: {
    verdict: "supported" | "insufficient" | "contradicted";
    reason: string;
  } | null;
}

export interface ExperienceLearningJob {
  jobId: string;
  repositoryId: string;
  cwd: string;
  threadId: string;
  status: "queued" | "running" | "completed" | "skipped" | "failed";
  createdAt: string;
  updatedAt: string;
  attempts: number;
  reason: string | null;
  candidateId: string | null;
}

export interface ExperienceLearningStatus {
  enabled: boolean;
  repositoryId: string;
  namespace: string;
  jobs: ExperienceLearningJob[];
  candidates: ExperienceCandidate[];
}
