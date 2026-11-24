import type { TerminalProgramStatusState } from "@runweave/shared/terminal/program-status";

export const programStatusLabels: Record<TerminalProgramStatusState, string> = {
  starting: "Starting",
  idle: "Idle",
  working: "Running",
  blocked: "Needs input",
  done: "Turn done",
  error: "Turn failed",
};
