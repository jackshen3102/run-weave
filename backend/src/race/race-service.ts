import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  CreateRaceRequest,
  RaceAgentCatalog,
  RaceRecord,
  RaceWorkerConfig,
} from "@runweave/shared/race";
import { buildTerminalChildProjectId } from "@runweave/shared/terminal/project-context";
import { prepareTerminalAgent } from "../terminal/application/agent-preparation";
import { ensureTerminalPanelWorkspace } from "../terminal/application/panel-workspace";
import {
  resolveDefaultTerminalArgs,
  resolveDefaultTerminalCommand,
} from "../terminal/runtime/default-shell";
import type { TerminalEventService } from "../terminal/state/terminal-event-service";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import type { PtyService } from "../terminal/runtime/pty-service";
import type { TerminalRuntimeRegistry } from "../terminal/runtime/registry";
import {
  killTmuxSessionForTerminal,
} from "../terminal/runtime/launcher";
import type { TerminalStateService } from "../terminal/state/terminal-state-service";
import type { TmuxOutputWatcher } from "../terminal/tmux/output-watcher";
import type { TmuxService } from "../terminal/tmux/service";
import { RaceRecordStore } from "./race-record-store";
import {
  RaceWorktreeSupply,
  RaceWorktreeSupplyError,
} from "./race-worktree-supply";

const CODEX_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.5",
  "gpt-5.4",
  "o3",
];
const TRAEX_MODEL_TIMEOUT_MS = 5_000;
const ANSI_COLOR_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*m`,
  "gu",
);

export class RaceError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RaceError";
  }
}

interface RaceServiceOptions {
  terminalSessionManager: TerminalSessionManager;
  terminalEventService: TerminalEventService;
  ptyService: PtyService;
  runtimeRegistry: TerminalRuntimeRegistry;
  terminalStateService: TerminalStateService;
  tmuxService: TmuxService;
  tmuxOutputWatcher: TmuxOutputWatcher;
  store: RaceRecordStore;
  worktreeSupply?: RaceWorktreeSupply;
}

function workerSuffix(index: number): string {
  let remaining = index;
  let suffix = "";
  do {
    suffix = String.fromCharCode(97 + (remaining % 26)) + suffix;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return suffix;
}

function workerLabel(index: number): string {
  return `Worker ${workerSuffix(index).toLocaleUpperCase()}`;
}

function modelArgs(worker: RaceWorkerConfig): string[] {
  const model = worker.model.trim();
  if (!model) {
    return [];
  }
  return worker.agent === "codex"
    ? ["-m", model]
    : ["-c", `model="${model}"`];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseTraexModels(output: string): string[] {
  const normalized = output.replace(ANSI_COLOR_PATTERN, "").trim();
  if (!normalized) {
    return [];
  }
  try {
    const parsed = JSON.parse(normalized) as unknown;
    const values: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value === "string") {
        values.push(value.trim());
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(collect);
        return;
      }
      if (value && typeof value === "object") {
        for (const [key, nested] of Object.entries(value)) {
          if (key === "id" || key === "name" || key === "model") {
            collect(nested);
          }
        }
      }
    };
    collect(parsed);
    return Array.from(new Set(values.filter(Boolean)));
  } catch {
    return Array.from(
      new Set(
        normalized
          .split(/\r?\n/u)
          .map((line) =>
            line
              .trim()
              .replace(/^[*+•>-]\s*/u, "")
              .replace(/^\[[x ]\]\s*/iu, ""),
          )
          .filter(
            (line) =>
              Boolean(line) &&
              !/^(available\s+)?models?:?$/iu.test(line) &&
              !line.includes(" "),
          ),
      ),
    );
  }
}

function listTraexModels(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      "traex",
      ["models"],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: TRAEX_MODEL_TIMEOUT_MS,
      },
      (error, stdout) => {
        resolve(error ? [] : parseTraexModels(stdout));
      },
    );
  });
}

export class RaceService {
  private readonly supply: RaceWorktreeSupply;
  private creating = false;
  private creationSettled: Promise<void> | null = null;
  private traexModels: Promise<string[]> | null = null;

  constructor(private readonly options: RaceServiceOptions) {
    this.supply = options.worktreeSupply ?? new RaceWorktreeSupply();
  }

  async initialize(): Promise<void> {
    await this.options.store.initialize();
    await this.reconcileRecoveredRecord();
  }

  async getCurrent(): Promise<RaceRecord | null> {
    if (!this.creating) {
      await this.reconcileRecoveredRecord();
    }
    return this.options.store.getCurrent();
  }

  async getAgentCatalog(): Promise<RaceAgentCatalog> {
    this.traexModels ??= listTraexModels();
    return {
      codex: { models: [...CODEX_MODELS], custom: true },
      traex: { models: await this.traexModels, custom: true },
    };
  }

  async create(request: CreateRaceRequest): Promise<RaceRecord> {
    if (this.creating || this.options.store.getCurrent()) {
      throw new RaceError(409, "A Race is already active", "race_exists");
    }
    const parentProject = this.options.terminalSessionManager
      .listProjects()
      .find((project) => project.id === request.parentProjectId);
    if (!parentProject?.path) {
      throw new RaceError(404, "Race parent project path is unavailable");
    }

    this.creating = true;
    let settleCreation!: () => void;
    const creationSettled = new Promise<void>((resolve) => {
      settleCreation = resolve;
    });
    this.creationSettled = creationSettled;
    const record: RaceRecord = {
      raceId: `race_${randomUUID()}`,
      goal: request.goal,
      plan: request.plan,
      baseRef: request.baseRef,
      parentProjectId: request.parentProjectId,
      createdAt: new Date().toISOString(),
      workers: request.workers.map((worker, index) => ({
        workerId: `worker_${workerSuffix(index)}`,
        label: workerLabel(index),
        agent: worker.agent,
        model: worker.model.trim(),
        worktreeId: null,
        worktreePath: null,
        branch: null,
        terminalSessionId: null,
        launchStatus: "starting",
      })),
    };
    try {
      await this.options.store.write(record);
      const plan = await this.supply
        .plan(
          parentProject.path,
          request.goal,
          request.baseRef,
          record.workers.length,
        )
        .catch(async (error: unknown) => {
          for (const worker of record.workers) {
            worker.launchStatus = "failed";
            worker.launchError = errorMessage(error);
          }
          await this.options.store.write(record);
          return null;
        });
      if (!plan) {
        return record;
      }

      await Promise.all(
        record.workers.map(async (worker, index) => {
          const plannedWorktree = plan.worktrees[index];
          if (!plannedWorktree) {
            worker.launchStatus = "failed";
            worker.launchError = "Race worktree plan is incomplete";
            return;
          }
          try {
            const created = await this.supply.create(plan, plannedWorktree);
            worker.worktreePath = created.worktreePath;
            worker.branch = created.branch;
            worker.worktreeId = buildTerminalChildProjectId(
              record.parentProjectId,
              created.name,
            );
          } catch (error) {
            worker.launchStatus = "failed";
            worker.launchError = errorMessage(error);
          }
        }),
      );
      await this.options.store.write(record);
      await this.options.terminalSessionManager.refreshProjectContexts(
        record.parentProjectId,
      );

      await Promise.all(
        record.workers.map(async (worker) => {
          if (
            worker.launchStatus === "failed" ||
            !worker.worktreeId ||
            !worker.worktreePath
          ) {
            return;
          }
          try {
            const command = resolveDefaultTerminalCommand();
            const session =
              await this.options.terminalSessionManager.createSession({
                projectId: worker.worktreeId,
                command,
                args: resolveDefaultTerminalArgs(command),
                cwd: worker.worktreePath,
              });
            worker.terminalSessionId = session.id;
            await this.options.terminalSessionManager.updateSessionAlias(
              session.id,
              worker.label,
            );
            if (!(await this.options.tmuxService.isAvailable())) {
              throw new Error("Terminal tmux service is unavailable");
            }
            const tmuxTarget = this.options.tmuxService.buildTarget(session.id);
            const tmuxSession =
              (await this.options.terminalSessionManager.updateRuntimeMetadata(
                session.id,
                {
                  runtimeKind: "tmux",
                  tmuxSessionName: tmuxTarget.sessionName,
                  tmuxSocketPath: tmuxTarget.socketPath,
                  recoverable: true,
                },
              )) ?? session;
            const panelWorkspace = await ensureTerminalPanelWorkspace(
              this.options.terminalSessionManager,
              tmuxSession,
              {
                ptyService: this.options.ptyService,
                runtimeRegistry: this.options.runtimeRegistry,
                terminalEventService: this.options.terminalEventService,
                tmuxService: this.options.tmuxService,
                tmuxOutputWatcher: this.options.tmuxOutputWatcher,
              },
            );
            await prepareTerminalAgent(
              this.options.terminalSessionManager,
              tmuxSession,
              {
                ptyService: this.options.ptyService,
                runtimeRegistry: this.options.runtimeRegistry,
                terminalEventService: this.options.terminalEventService,
                terminalStateService: this.options.terminalStateService,
                tmuxService: this.options.tmuxService,
                tmuxOutputWatcher: this.options.tmuxOutputWatcher,
              },
              {
                agent: worker.agent,
                prompt: record.goal,
                panelId: panelWorkspace.activePanelId,
                cwd: worker.worktreePath,
                args: modelArgs(worker),
              },
            );
            worker.launchStatus = "launched";
            delete worker.launchError;
          } catch (error) {
            worker.launchStatus = "failed";
            worker.launchError = errorMessage(error);
          }
        }),
      );
      await this.options.store.write(record);
      return record;
    } finally {
      this.creating = false;
      settleCreation();
      if (this.creationSettled === creationSettled) {
        this.creationSettled = null;
      }
    }
  }

  async end(raceId: string): Promise<void> {
    await this.creationSettled;
    const record = this.requireCurrent(raceId);
    await Promise.all(
      record.workers.map((worker) =>
        this.stopWorkerSession(worker.terminalSessionId),
      ),
    );
    await this.options.store.clear();
  }

  async removeWorktree(raceId: string, workerId: string): Promise<void> {
    const record = this.requireCurrent(raceId);
    const worker = record.workers.find(
      (candidate) => candidate.workerId === workerId,
    );
    if (!worker?.worktreePath) {
      throw new RaceError(404, "Race worker worktree not found");
    }
    const parentProject = this.options.terminalSessionManager
      .listProjects()
      .find((project) => project.id === record.parentProjectId);
    if (!parentProject?.path) {
      throw new RaceError(409, "Race parent project path is unavailable");
    }

    await this.supply.remove(
      parentProject.path,
      worker.worktreePath,
      () => this.stopWorkerSession(worker.terminalSessionId),
    );
    worker.terminalSessionId = null;
    worker.launchStatus = "failed";
    worker.launchError = "Race worktree was removed";
    await this.options.terminalSessionManager.refreshProjectContexts(
      record.parentProjectId,
    );
    await this.options.store.write(record);
  }

  async waitForWorktreeCreation(): Promise<void> {
    await this.creationSettled;
  }

  async markWorktreeRemoved(
    parentProjectId: string,
    worktreeId: string,
  ): Promise<void> {
    const record = this.options.store.getCurrent();
    if (!record || record.parentProjectId !== parentProjectId) {
      return;
    }
    const worker = record.workers.find(
      (candidate) => candidate.worktreeId === worktreeId,
    );
    if (!worker) {
      return;
    }
    worker.terminalSessionId = null;
    worker.launchStatus = "failed";
    worker.launchError = "Race worktree was removed";
    await this.options.store.write(record);
  }

  private requireCurrent(raceId: string): RaceRecord {
    const record = this.options.store.getCurrent();
    if (!record || record.raceId !== raceId) {
      throw new RaceError(404, "Race not found");
    }
    return record;
  }

  private async stopWorkerSession(
    terminalSessionId: string | null,
  ): Promise<void> {
    if (!terminalSessionId) {
      return;
    }
    const session =
      this.options.terminalSessionManager.getSession(terminalSessionId);
    if (!session) {
      return;
    }
    await this.options.runtimeRegistry.disposeRuntime(terminalSessionId);
    await this.options.tmuxOutputWatcher.unwatchSession(terminalSessionId);
    await killTmuxSessionForTerminal(session, this.options.tmuxService);
    await this.options.terminalSessionManager.destroySession(
      terminalSessionId,
    );
  }

  private async reconcileRecoveredRecord(): Promise<void> {
    const record = this.options.store.getCurrent();
    if (!record) {
      return;
    }
    const parentProject = this.options.terminalSessionManager
      .listProjects()
      .find((project) => project.id === record.parentProjectId);
    let changed = false;
    for (const worker of record.workers) {
      if (worker.launchStatus === "failed") {
        continue;
      }
      const worktreePresent =
        Boolean(parentProject?.path && worker.worktreePath) &&
        (await this.supply.isRegistered(
          parentProject!.path!,
          worker.worktreePath!,
        ));
      if (!worktreePresent) {
        worker.launchStatus = "failed";
        worker.launchError = "Race worktree is missing";
        changed = true;
        continue;
      }
      const session = worker.terminalSessionId
        ? this.options.terminalSessionManager.getSession(
            worker.terminalSessionId,
          )
        : null;
      if (!session) {
        worker.launchStatus = "failed";
        worker.launchError = "Race terminal session is missing";
        changed = true;
      }
    }
    if (changed) {
      await this.options.store.write(record);
    }
  }
}

export function toRaceError(error: unknown): RaceError {
  if (error instanceof RaceError) {
    return error;
  }
  if (error instanceof RaceWorktreeSupplyError) {
    return new RaceError(error.statusCode, error.message);
  }
  return new RaceError(500, errorMessage(error));
}
