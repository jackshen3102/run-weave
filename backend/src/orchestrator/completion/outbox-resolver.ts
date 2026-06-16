import type {
  OrchestratorDispatchSidecar,
  OrchestratorWorkerOutbox,
  TerminalEventEnvelope,
} from "@runweave/shared";
import type { TerminalSessionManager } from "../../terminal/manager";
import type { OrchestratorRunStore } from "../storage/run-store";
import type { OrchestratorPaths } from "../storage/orchestrator-paths";
import type { OrchestratorSidecarStore } from "../storage/sidecar-store";
import { readJsonFile } from "../storage/json-file";
import {
  extractWorkerPromptContext,
  extractWorkerSummaryFromScrollback,
} from "./scrollback-parser";

type CompletionEvent = Extract<TerminalEventEnvelope, { kind: "completion" }>;

export class OrchestratorOutboxResolver {
  constructor(
    private readonly options: {
      terminalSessionManager: TerminalSessionManager;
      runStore: OrchestratorRunStore;
      paths: OrchestratorPaths;
      sidecarStore: OrchestratorSidecarStore;
    },
  ) {}

  async resolveOutbox(
    event: CompletionEvent,
  ): Promise<OrchestratorWorkerOutbox | null> {
    const outboxPath =
      event.payload.outboxPath ??
      this.options.paths.defaultOutboxPath(
        event.projectId,
        event.terminalSessionId,
        event.payload.cwd,
      );
    const outbox = await readJsonFile<OrchestratorWorkerOutbox>(outboxPath);
    if (outbox?.runId) {
      return outbox;
    }
    const sidecar = await this.options.sidecarStore.readDispatchSidecar({
      projectId: event.projectId,
      terminalSessionId: event.terminalSessionId,
      cwd: event.payload.cwd,
    });
    if (sidecar && outbox) {
      return {
        ...outbox,
        runId: sidecar.runId,
        goalId: sidecar.goalId,
        role: sidecar.role,
      };
    }
    return this.buildFallbackOutbox(event, outbox, sidecar);
  }

  private async buildFallbackOutbox(
    event: CompletionEvent,
    outbox: OrchestratorWorkerOutbox | null,
    sidecar: OrchestratorDispatchSidecar | null,
  ): Promise<OrchestratorWorkerOutbox | null> {
    const session = this.options.terminalSessionManager.getSession(
      event.terminalSessionId,
    );
    if (!session) {
      return null;
    }
    const scrollback = await this.options.terminalSessionManager.readScrollback(
      session.id,
    );
    const context = extractWorkerPromptContext(scrollback);
    const runId = outbox?.runId ?? sidecar?.runId ?? context.runId;
    if (!runId) {
      return outbox;
    }
    const run = await this.options.runStore.getRun(runId);
    if (!run) {
      return outbox;
    }
    const boundRole = run.roles.find(
      (role) => role.binding.sessionId === event.terminalSessionId,
    );
    const summary =
      outbox?.summary ??
      event.payload.summary ??
      extractWorkerSummaryFromScrollback(scrollback, context);
    return {
      sessionId: event.terminalSessionId,
      projectId: event.projectId,
      runId,
      role: outbox?.role ?? sidecar?.role ?? context.role ?? boundRole?.id ?? null,
      goalId: outbox?.goalId ?? sidecar?.goalId ?? context.goalId,
      status: outbox?.status ?? "completed",
      summary,
      artifacts: outbox?.artifacts ?? [],
      error: outbox?.error ?? null,
      completionReason: event.payload.completionReason,
      finishedAt: event.createdAt,
    };
  }
}
