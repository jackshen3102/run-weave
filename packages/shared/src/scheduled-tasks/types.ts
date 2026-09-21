export type ScheduledTaskProvider = "codex" | "trae" | "pi";

/** Weekdays use 0 = Sunday through 6 = Saturday. All timestamps are UTC ISO strings. */
export type TaskSchedule =
  | { kind: "daily" | "weekdays"; timezone: string; localTime: string }
  | { kind: "weekly"; timezone: string; localTime: string; weekdays: number[] }
  | { kind: "once"; timezone: string; runAt: string };

export interface ScheduledTaskConfig {
  name: string;
  projectId: string;
  provider: ScheduledTaskProvider;
  prompt: string;
  model?: string;
  effort?: string;
  schedule: TaskSchedule;
}

export interface ScheduledTask extends ScheduledTaskConfig {
  id: string;
  revision: number;
  enabled: boolean;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type ScheduledRunStatus =
  | "queued"
  | "running"
  | "stopping"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";
export type AttachmentState = "creating" | "starting" | "ready" | "failed";
export interface ScheduledTerminalBinding {
  terminalSessionId: string;
  panelId: string;
  attachmentState: AttachmentState;
  error?: string;
}

export interface ScheduledRun {
  id: string;
  taskId: string;
  taskRevision: number;
  snapshot: ScheduledTaskConfig;
  trigger: "scheduled" | "manual";
  scheduledFor: string;
  status: ScheduledRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  summary: string | null;
  error: { code: string; message: string } | null;
  artifacts: Array<{
    label: string;
    kind: "link" | "file" | "text";
    url?: string;
    text?: string;
    fileRef?: string;
  }>;
  outputCursor: string | null;
  executionProjectId: string;
  cwd: string;
  threadRef: {
    provider: ScheduledTaskProvider;
    threadId: string;
    sessionFile?: string;
  } | null;
  /** Backend confirms the execution owner has released this thread. */
  recoverable: boolean;
  terminalBinding: ScheduledTerminalBinding | null;
}

export interface ScheduledTaskSource {
  type: "scheduled-task";
  taskId: string;
  runId: string;
}
