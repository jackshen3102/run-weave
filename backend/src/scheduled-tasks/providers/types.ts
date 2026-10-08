import type {
  ScheduledTaskProvider,
  ScheduledExecutionPolicy,
  ScheduledTaskOutcome,
  ScheduledRecovery,
} from "@runweave/shared/scheduled-tasks";

export interface ScheduledProviderRequest {
  runId: string;
  projectId: string;
  prompt: string;
  workingDirectory: string;
  model?: string;
  effort?: string;
  executionPolicy?: ScheduledExecutionPolicy;
  resumeThreadId?: string;
  maxOutputBytes: number;
  maxWallTimeMs: number;
  signal: AbortSignal;
  onOutput: (text: string) => Promise<boolean>;
  onSpawn: (pid: number) => Promise<void>;
  onThread: (threadId: string) => Promise<void>;
}

export interface ScheduledProviderResult {
  provider: ScheduledTaskProvider;
  threadId: string;
  summary: string;
  outcome: ScheduledTaskOutcome;
  reason: string;
  recovery?: ScheduledRecovery | null;
}

export interface ScheduledProviderAdapter {
  provider: ScheduledTaskProvider;
  run(request: ScheduledProviderRequest): Promise<ScheduledProviderResult>;
}
