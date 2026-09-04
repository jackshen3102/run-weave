import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";
import type { TerminalProjectContextListItem } from "@runweave/shared/terminal/project-context";
import type { WorkspaceServiceListResponse } from "@runweave/shared/terminal/workspace-service";
import {
  listTerminalProjectContexts,
  listTerminalProjects,
  listTerminalSessions,
  listTerminalWorkspaceServices,
} from "../../../services/terminal/index";
import { terminalQueryKeys } from "./keys";
import { useTerminalRuntime } from "./provider";

export const EMPTY_TERMINAL_PROJECTS: TerminalProjectListItem[] = [];
export const EMPTY_TERMINAL_SESSIONS: TerminalSessionListItem[] = [];
export const EMPTY_TERMINAL_PROJECT_CONTEXTS: TerminalProjectContextListItem[] = [];

function workspaceServiceRefetchInterval(
  query: { state: { data?: WorkspaceServiceListResponse } },
): number {
  const transitioning = query.state.data?.services.some(
    (service) => service.status === "starting" || service.status === "stopping",
  );
  return transitioning ? 1_000 : 3_000;
}

export function useTerminalProjectsQuery() {
  const { apiBase, scope, token } = useTerminalRuntime();
  return useQuery({
    queryKey: terminalQueryKeys.projects(scope),
    queryFn: () => listTerminalProjects(apiBase, token),
  });
}

export function useTerminalSessionsQuery() {
  const { apiBase, scope, token } = useTerminalRuntime();
  return useQuery({
    queryKey: terminalQueryKeys.sessions(scope),
    queryFn: () => listTerminalSessions(apiBase, token),
  });
}

export function useTerminalProjectContextsQuery(
  parentProjectId: string | null,
) {
  const { apiBase, scope, token } = useTerminalRuntime();
  return useQuery({
    queryKey: terminalQueryKeys.projectContexts(scope, parentProjectId ?? ""),
    queryFn: () =>
      listTerminalProjectContexts(apiBase, token, parentProjectId ?? ""),
    enabled: Boolean(parentProjectId),
    refetchInterval: 3_000,
    refetchOnWindowFocus: true,
  });
}

export function useTerminalWorkspaceServicesQuery(
  parentProjectId: string | null,
  projectId: string | null,
  enabled = true,
) {
  const { apiBase, scope, token } = useTerminalRuntime();
  return useQuery({
    queryKey: terminalQueryKeys.workspaceServices(
      scope,
      parentProjectId ?? "",
      projectId ?? "",
    ),
    queryFn: () =>
      listTerminalWorkspaceServices(
        apiBase,
        token,
        parentProjectId ?? "",
        projectId ?? "",
      ),
    enabled: enabled && Boolean(parentProjectId && projectId),
    refetchInterval: workspaceServiceRefetchInterval,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

export function useTerminalWorkspaceQueryClient() {
  const queryClient = useQueryClient();
  const { scope } = useTerminalRuntime();
  return { queryClient, scope };
}

export function updateTerminalProjects(
  queryClient: QueryClient,
  scope: string,
  updater: (current: TerminalProjectListItem[]) => TerminalProjectListItem[],
): void {
  queryClient.setQueryData<TerminalProjectListItem[]>(
    terminalQueryKeys.projects(scope),
    (current) => updater(current ?? EMPTY_TERMINAL_PROJECTS),
  );
}

export function updateTerminalSessions(
  queryClient: QueryClient,
  scope: string,
  updater: (current: TerminalSessionListItem[]) => TerminalSessionListItem[],
): void {
  queryClient.setQueryData<TerminalSessionListItem[]>(
    terminalQueryKeys.sessions(scope),
    (current) => updater(current ?? EMPTY_TERMINAL_SESSIONS),
  );
}
