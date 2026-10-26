/** The UI describes the displayed range, never an exact behind count at the limit. */
export const BRANCH_UPDATES_LIMIT = 10;

export function branchUpdatesCountLabel(count: number): string {
  return count >= BRANCH_UPDATES_LIMIT ? `最近 ${BRANCH_UPDATES_LIMIT} 条` : `${count} 条`;
}

export type BranchUpdatesTarget =
  | { kind: "project"; projectId: string; path: string }
  | { kind: "terminal"; terminalSessionId: string; cwd: string };

export interface BranchUpdateCommit {
  oid: string;
  subject: string;
  authorName: string;
  committedAt: string;
}

export interface BranchUpdatesSnapshot {
  headOid: string;
  currentBranch: string | null;
  baseRemote: string;
  baseBranch: string;
  baseOid: string;
  checkedAt: string;
  items: BranchUpdateCommit[];
}

export interface BranchUpdatesResponse {
  target: BranchUpdatesTarget;
  state: "ready" | "stale" | "unavailable" | "not-repository";
  snapshot?: BranchUpdatesSnapshot;
  reason?: "remote-unavailable" | "shallow-repository" | "unrelated-history";
}
