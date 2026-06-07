import type {
  TerminalMobileOverviewResponse,
  TerminalMobileOverviewSession,
  TerminalProjectListItem,
} from "@browser-viewer/shared";

export interface TerminalHomeProjectGroup {
  project: TerminalProjectListItem;
  sessions: TerminalMobileOverviewSession[];
  terminalCount: number;
}

function normalize(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function matchesSession(
  session: TerminalMobileOverviewSession,
  query: string,
): boolean {
  return [
    session.title,
    session.subtitle,
    session.command,
    session.activeCommand,
    session.cwd,
  ].some((value) => normalize(value).includes(query));
}

function matchesProject(
  project: TerminalProjectListItem,
  query: string,
): boolean {
  return [project.name, project.path].some((value) =>
    normalize(value).includes(query),
  );
}

export function buildTerminalHomeGroups(
  overview: TerminalMobileOverviewResponse,
  rawQuery: string,
): TerminalHomeProjectGroup[] {
  const query = rawQuery.trim().toLowerCase();
  const sessionsByProject = new Map<string, TerminalMobileOverviewSession[]>();

  for (const session of overview.sessions) {
    const current = sessionsByProject.get(session.projectId) ?? [];
    current.push(session);
    sessionsByProject.set(session.projectId, current);
  }

  return overview.projects
    .map((project) => {
      const projectSessions = sessionsByProject.get(project.projectId) ?? [];
      if (!query || matchesProject(project, query)) {
        return {
          project,
          sessions: projectSessions,
          terminalCount: projectSessions.length,
        };
      }

      const matchingSessions = projectSessions.filter((session) =>
        matchesSession(session, query),
      );
      return {
        project,
        sessions: matchingSessions,
        terminalCount: projectSessions.length,
      };
    })
    .filter(
      (group) =>
        !query ||
        matchesProject(group.project, query) ||
        group.sessions.length > 0,
    );
}

export function formatRelativeTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return "";
  }

  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) {
    return "now";
  }
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h`;
  }
  return `${Math.floor(diffHours / 24)}d`;
}
