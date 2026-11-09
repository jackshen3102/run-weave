import path from "node:path";
import { acquireBackendProfileLock } from "../server/profile-lock";
import type { ResourceScope } from "./resource-scope";
import { createScheduledTaskSubsystem, type ScheduledTaskSubsystem } from "../scheduled-tasks/bootstrap";
import type { TerminalActivityDependencies } from "../terminal/runtime/activity-events";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import type { TerminalRuntimeRegistry } from "../terminal/runtime/registry";
import type { PtyService } from "../terminal/runtime/pty-service";
import type { TerminalEventService } from "../terminal/state/terminal-event-service";
import type { TerminalStateService } from "../terminal/state/terminal-state-service";
import type { TmuxOutputWatcher } from "../terminal/tmux/output-watcher";
import type { TmuxService } from "../terminal/tmux/service";
import { resolveScheduledTaskStoragePaths } from "../utils/path";

export async function createScheduledTasks(
  resources: ResourceScope,
  input: {
    browserProfileDir: string;
    terminalSessionManager: TerminalSessionManager;
    terminalRuntimeRegistry: TerminalRuntimeRegistry;
    ptyService: PtyService;
    tmuxService: TmuxService;
    tmuxOutputWatcher: TmuxOutputWatcher;
    terminalEventService: TerminalEventService;
    terminalStateService: TerminalStateService;
    terminalActivity: TerminalActivityDependencies;
  },
): Promise<ScheduledTaskSubsystem> {
  const paths = resolveScheduledTaskStoragePaths();
  const lock = await acquireBackendProfileLock({ profileDir: path.join(path.dirname(paths.scheduledTasksDatabaseFile), "database-owner"), port: null, host: undefined });
  resources.defer("scheduled-task-data-lock", () => lock.release());
  const subsystem = await createScheduledTaskSubsystem({
    databasePath: paths.scheduledTasksDatabaseFile,
    terminalSessionManager: input.terminalSessionManager,
    env: process.env,
    terminalOptions: {
      ptyService: input.ptyService,
      runtimeRegistry: input.terminalRuntimeRegistry,
      tmuxService: input.tmuxService,
      tmuxOutputWatcher: input.tmuxOutputWatcher,
      terminalEventService: input.terminalEventService,
      terminalStateService: input.terminalStateService,
      activity: input.terminalActivity,
    },
  });
  resources.defer("scheduled-task-migration", () => subsystem.service.migration?.maintenance.dispose());
  if (subsystem.store) resources.defer("scheduled-task-store", () => subsystem.store!.dispose());
  if (subsystem.runtime) resources.defer("scheduled-task-runtime", () => subsystem.runtime!.dispose());
  return subsystem;
}
