import { matchPath } from "react-router-dom";

const screens = [
  ["/connections", "connections"],
  ["/login", "login"],
  ["/terminal", "terminal_list"],
  ["/terminal/:terminalSessionId", "terminal_workspace"],
  ["/scheduled-tasks/:taskId?", "scheduled_tasks"],
  ["/background-runs/:runId", "background_run"],
  ["/execution-efficiency/:findingId?", "execution_efficiency"],
  ["/activity", "activity"],
  ["/evolution", "evolution"],
  ["/system-monitor", "system_monitor"],
  ["/prototypes", "prototypes"],
  ["/prototypes/:projectId/:prototypeSource/:prototypeSlug", "prototypes"],
] as const;

export type AnalyticsScreen = (typeof screens)[number][1];

export function classifyAnalyticsScreen(pathname: string): AnalyticsScreen | null {
  return screens.find(([pattern]) => matchPath(pattern, pathname))?.[1] ?? null;
}
