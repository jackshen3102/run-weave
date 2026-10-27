export interface CreateTerminalProjectRequest {
  name: string;
  path?: string | null;
}

export interface UpdateTerminalProjectRequest {
  /** Remote branch name; null restores the remote default branch. */
  mainBranch?: string | null;
  name?: string;
  path?: string | null;
}

export interface TerminalProjectListItem {
  /** Missing/null uses the remote default branch. */
  mainBranch?: string | null;
  projectId: string;
  name: string;
  path: string | null;
  createdAt: string;
  isDefault: boolean;
}
