/** Local Agent evidence exchanged between the collector, the Skill and renderer. */
export type DailyProvider = "codex" | "pi" | "claude" | "trae";

export interface DailyProject {
  /** git:<canonical common directory>, or unclassified; shared across worktrees. */
  id: string;
  name: string;
}

export interface DailyMaterial {
  id: string;
  provider: DailyProvider;
  threadId: string;
  cwd: string;
  /** Optional in earlier material bundles. */
  project?: DailyProject;
  origin: "interactive" | "background" | "subagent";
  role: "user" | "assistant" | "tool";
  phase?: string;
  toolName?: string;
  callId?: string;
  parentId?: string;
  occurredAt: string;
  day: string;
  text: string;
  textSha256: string;
  locator: {
    path: string;
    line: number;
    byteOffset: number;
    byteLength: number;
    sha256: string;
  };
}

export interface DailySourceReceipt {
  provider: DailyProvider;
  root: string;
  status: "complete" | "partial" | "unavailable";
  scannedFiles: number;
  materials: number;
  excluded: Record<string, number>;
  issues: string[];
}

export interface DailyManifest {
  schemaVersion: 1;
  collectionId: string;
  machineId: string;
  collectedAt: string;
  from: string;
  to: string;
  timeZone: string;
  days: string[];
  materialsSha256: string;
  sources: DailySourceReceipt[];
}

export type DailyAction =
  | "discussed"
  | "attempted"
  | "changed"
  | "verified"
  | "reported";

export interface DailyFact {
  statement: string;
  action: DailyAction;
  sourceIds: string[];
  /** Inferred from source materials when absent in earlier facts files. */
  project?: DailyProject;
}

export interface DailyFacts {
  schemaVersion: 1;
  collectionId: string;
  days: Array<{ date: string; items: DailyFact[] }>;
}
