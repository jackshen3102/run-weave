export interface CreateTerminalProjectRequest {
  name: string;
  path?: string | null;
}

export interface UpdateTerminalProjectRequest {
  name?: string;
  path?: string | null;
}

export interface TerminalProjectListItem {
  projectId: string;
  name: string;
  path: string | null;
  createdAt: string;
  isDefault: boolean;
}
