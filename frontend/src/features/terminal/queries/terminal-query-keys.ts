import type { TerminalPreviewChangeKind } from "@runweave/shared/terminal/preview";

export const terminalQueryKeys = {
  all: (scope: string) => ["connection", scope, "terminal"] as const,
  projects: (scope: string) =>
    [...terminalQueryKeys.all(scope), "projects"] as const,
  sessions: (scope: string) =>
    [...terminalQueryKeys.all(scope), "sessions"] as const,
  preview: (scope: string, projectId: string) =>
    [...terminalQueryKeys.all(scope), "preview", projectId] as const,
  previewFileSearch: (input: {
    scope: string;
    projectId: string;
    query: string;
  }) =>
    [
      ...terminalQueryKeys.preview(input.scope, input.projectId),
      "file-search",
      input.query,
    ] as const,
  previewFile: (input: { scope: string; projectId: string; path: string }) =>
    [
      ...terminalQueryKeys.preview(input.scope, input.projectId),
      "file",
      input.path,
    ] as const,
  previewChanges: (scope: string, projectId: string) =>
    [...terminalQueryKeys.preview(scope, projectId), "changes"] as const,
  previewDiff: (input: {
    scope: string;
    projectId: string;
    path: string;
    kind: TerminalPreviewChangeKind;
  }) =>
    [
      ...terminalQueryKeys.preview(input.scope, input.projectId),
      "diff",
      input.kind,
      input.path,
    ] as const,
};
