import type {
  WorkspaceServiceError,
  WorkspaceServiceErrorCode,
} from "@runweave/shared/terminal/workspace-service";

export class WorkspaceServiceRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: WorkspaceServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceServiceRequestError";
  }

  toPayload(): WorkspaceServiceError {
    return { code: this.code, message: this.message };
  }
}

export function workspaceServiceError(
  code: WorkspaceServiceErrorCode,
  message: string,
): WorkspaceServiceError {
  return { code, message };
}
