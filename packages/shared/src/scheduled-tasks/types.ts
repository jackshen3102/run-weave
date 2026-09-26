export type ScheduledTaskProvider = "codex" | "trae" | "pi";
export type ScheduledExecutionPolicy =
  | "sandbox"
  | "auto-review"
  | "full-access";
export type ScheduledTaskOutcome = "succeeded" | "blocked" | "failed";

/** Weekdays use 0 = Sunday through 6 = Saturday. All timestamps are UTC ISO strings. */
export type TaskSchedule =
  | { kind: "daily" | "weekdays"; timezone: string; localTime: string }
  | { kind: "weekly"; timezone: string; localTime: string; weekdays: number[] }
  | { kind: "once"; timezone: string; runAt: string };

export type ScheduledMisfirePolicy =
  | { mode: "skip" }
  | { mode: "catch-up-latest"; maxDelaySeconds: number };

export interface ScheduledTaskConfig {
  name: string;
  projectId: string;
  provider: ScheduledTaskProvider;
  prompt: string;
  model?: string;
  effort?: string;
  /** Absent on older tasks: preserve sandbox-only execution. */
  executionPolicy?: ScheduledExecutionPolicy;
  schedule: TaskSchedule;
  misfirePolicy: ScheduledMisfirePolicy;
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
  /** Admission timing, separate from time spent waiting in the execution queue. */
  dispatch: {
    evaluatedAt: string;
    latenessMs: number;
    catchUp: boolean;
    coalescedFrom?: string;
  } | null;
  status: ScheduledRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  summary: string | null;
  /** Agent-reported business result; absent on legacy runs. */
  outcome?: ScheduledTaskOutcome;
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
