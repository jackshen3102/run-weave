import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";
import {
  listTerminalProjects,
  listTerminalSessions,
} from "../../../services/terminal";
import { terminalQueryKeys } from "./terminal-query-keys";
import { useTerminalRuntime } from "./terminal-runtime-provider";

export const EMPTY_TERMINAL_PROJECTS: TerminalProjectListItem[] = [];
export const EMPTY_TERMINAL_SESSIONS: TerminalSessionListItem[] = [];

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
