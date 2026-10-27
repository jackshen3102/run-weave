/** Work dates are business dates in Asia/Shanghai, independent of capture time. */
export type WorkStatus =
  | "progress"
  | "discussed"
  | "documented"
  | "attempted"
  | "agent-reported"
  | "verified";
export type WorkField =
  | "workDate"
  | "title"
  | "statement"
  | "status"
  | "project";
export type WorkFactInput = {
  workDate: string;
  title: string;
  statement: string;
  status: WorkStatus;
  project: string | null;
};
export type WorkFact = WorkFactInput & {
  id: string;
  eventKey: string;
  timeZone: "Asia/Shanghai";
  version: number;
  createdAt: string;
  updatedAt: string;
  createdVia: "app" | "agent";
  manualFields: WorkField[];
};
export type WorkDay = {
  date: string;
  count: number;
  coverage: "complete" | "partial" | "unknown";
};
export type WorkFactPage = {
  items: WorkFact[];
  days: WorkDay[];
  nextCursor: string | null;
  feedRevision: string;
};
export type WorkFactFilter = {
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
};
export type WorkFactEdit = Partial<WorkFactInput> & { expectedVersion: number };
export type WorkReclassification = {
  items: { id: string; expectedVersion: number }[];
  project: string | null;
};
export type WorkProjectRestore = {
  items: { id: string; expectedVersion: number; project: string | null }[];
};
export type WorkSourceRef = {
  channel:
    | "local-agent"
    | "feishu-message"
    | "feishu-document"
    | "browser-visit";
  sourceScope: string;
  nativeId: string;
  revision?: string;
  hash?: string;
};
export type WorkReceipt = {
  sourceScope: string;
  status: "complete" | "partial" | "unavailable";
  collectedAt: string;
  from: string;
  to: string;
};
export type ImportedWorkFact = Omit<WorkFactInput, "workDate"> & {
  externalKey: string;
  eventKey: string;
  sourceRefs: WorkSourceRef[];
};
export type ImportWorkFacts = {
  schemaVersion: 1;
  sourceNamespace: string;
  sourceCollectedAt: string;
  basedOnFeedRevision: string;
  days: {
    date: string;
    requestedScopes: string[];
    receipts: WorkReceipt[];
    facts: ImportedWorkFact[];
  }[];
};
export type WorkImportResult = {
  importId: string;
  feedRevision: string;
  created: number;
  updated: number;
  unchanged: number;
  protected: number;
  facts: {
    externalKey: string;
    id: string;
    version: number;
    sourceHash: string;
    fact: WorkFact;
  }[];
};

/** Expected reporting scopes; dates are Shanghai business dates, end exclusive. */
export type WorkSource = {
  sourceScope: string;
  producerId: string;
  sourceNamespace: string;
  name: string;
  effectiveFrom: string;
  effectiveTo: string | null;
};
export type WorkSourcePage = {
  items: WorkSource[];
  days: { date: string; receipts: WorkReceipt[]; missingScopes: string[] }[];
};
