import type {
  WorkspaceServiceListResponse,
  WorkspaceServiceMutationResponse,
  WorkspaceServiceSnapshot,
} from "@runweave/shared/terminal/workspace-service";
import type {
  TerminalProjectContextRecord,
  TerminalSessionManager,
} from "../manager/manager";
import {
  WorkspaceServiceConfigLoader,
  type WorkspaceServiceConfigLoadResult,
  type WorkspaceServiceDefinition,
} from "./config";
import { buildWorkspaceServiceEnvironment } from "./environment";
import {
  WorkspaceServiceRequestError,
  workspaceServiceError,
} from "./errors";
import { waitForWorkspaceServiceReady } from "./health";
import {
  buildWorkspaceServiceIdentity,
  buildWorkspaceServiceUrl,
  type WorkspaceServiceIdentity,
} from "./identity";
import {
  startOwnedWorkspaceServiceProcess,
  type OwnedWorkspaceServiceExit,
} from "./owned-process";
import {
  allocateEphemeralPort,
  exitDescription,
  forgetWorkspaceServiceContexts,
  KeyedMutex,
  statusHasLiveProcess,
} from "./manager-runtime";
import type { WorkspaceServiceProxyRoute, WorkspaceServiceRecord } from "./manager-types";

const SERVICE_HOST = "127.0.0.1";

export type { WorkspaceServiceProxyRoute } from "./manager-types";

export class WorkspaceServiceManager {
  private readonly configLoader = new WorkspaceServiceConfigLoader();
  private readonly contextMutex = new KeyedMutex();
  private readonly records = new Map<string, WorkspaceServiceRecord>();
  private readonly hostnameToKey = new Map<string, string>();
  private readonly deletingProjectIds = new Set<string>();
  private proxyPort: number | null = null;

  constructor(private readonly terminalSessionManager: TerminalSessionManager) {}

  setProxyPort(port: number): void {
    this.proxyPort = port;
  }

  async list(
    parentProjectId: string,
    projectId: string,
  ): Promise<WorkspaceServiceListResponse> {
    const context = this.resolveContext(parentProjectId, projectId);
    const loaded = await this.configLoader.load(context.path!);
    this.synchronizeHostnames(parentProjectId, context, loaded);
    return this.toListResponse(parentProjectId, context, loaded);
  }

  async start(input: {
    parentProjectId: string;
    projectId: string;
    serviceName: string;
    configRevision: string;
  }): Promise<WorkspaceServiceMutationResponse> {
    if (this.deletingProjectIds.has(input.projectId)) {
      throw new WorkspaceServiceRequestError(
        409,
        "context_deleting",
        "Terminal Project Context deletion is in progress",
      );
    }
    const release = await this.contextMutex.acquire(input.projectId);
    try {
      if (this.deletingProjectIds.has(input.projectId)) {
        throw new WorkspaceServiceRequestError(
          409,
          "context_deleting",
          "Terminal Project Context deletion is in progress",
        );
      }
      const context = this.resolveContext(input.parentProjectId, input.projectId);
      const loaded = await this.configLoader.load(context.path!);
      if (loaded.config.status !== "valid") {
        throw new WorkspaceServiceRequestError(
          422,
          "config_invalid",
          loaded.config.error?.message ?? "runweave.json is required",
        );
      }
      if (loaded.config.revision !== input.configRevision) {
        throw new WorkspaceServiceRequestError(
          409,
          "config_changed",
          "runweave.json changed; refresh before starting the service",
        );
      }
      const definition = loaded.definitions.find(
        (candidate) => candidate.name === input.serviceName,
      );
      if (!definition) {
        throw new WorkspaceServiceRequestError(
          404,
          "service_not_found",
          "Workspace service not found",
        );
      }
      this.synchronizeHostnames(input.parentProjectId, context, loaded);
      const identity = this.buildIdentity(
        input.parentProjectId,
        context,
        definition.name,
      );
      const existing = this.records.get(identity.key);
      if (existing?.status === "starting" || existing?.status === "ready") {
        return {
          accepted: false,
          service: this.toSnapshot(existing, loaded.config.revision),
        };
      }
      if (existing?.status === "stopping") {
        throw new WorkspaceServiceRequestError(
          409,
          "start_blocked",
          "Workspace service is stopping",
        );
      }
      const proxyPort = this.requireProxyPort();
      const serviceUrls = this.buildServiceUrls(
        input.parentProjectId,
        context,
        loaded.definitions,
        proxyPort,
      );
      const targetPort = await allocateEphemeralPort(SERVICE_HOST).catch(() => {
        throw new WorkspaceServiceRequestError(
          503,
          "port_unavailable",
          "No local port is available for the workspace service",
        );
      });
      const generation = (existing?.generation ?? 0) + 1;
      const record: WorkspaceServiceRecord = {
        identity,
        parentProjectId: input.parentProjectId,
        projectId: input.projectId,
        definition,
        configRevision: loaded.config.revision,
        status: "starting",
        targetPort,
        process: null,
        readinessAbort: new AbortController(),
        generation,
        exitCode: null,
        error: null,
      };
      this.records.set(identity.key, record);
      this.registerHostname(identity);

      try {
        record.process = await startOwnedWorkspaceServiceProcess({
          command: definition.command,
          cwd: definition.cwdPath,
          env: buildWorkspaceServiceEnvironment({
            definitions: loaded.definitions,
            host: SERVICE_HOST,
            port: targetPort,
            projectId: input.projectId,
            serviceName: definition.name,
            serviceUrls,
          }),
        });
        void this.settleStart(record);
      } catch {
        record.status = "failed";
        record.targetPort = null;
        record.readinessAbort = null;
        record.error = workspaceServiceError(
          "process_exited",
          "Workspace service process could not be started",
        );
      }

      return {
        accepted: true,
        service: this.toSnapshot(record, loaded.config.revision),
      };
    } finally {
      release();
    }
  }

  async stop(input: {
    parentProjectId: string;
    projectId: string;
    serviceName: string;
  }): Promise<WorkspaceServiceMutationResponse> {
    const release = await this.contextMutex.acquire(input.projectId);
    try {
      const context = this.resolveContext(input.parentProjectId, input.projectId);
      const identity = this.buildIdentity(
        input.parentProjectId,
        context,
        input.serviceName,
      );
      const record = this.records.get(identity.key);
      if (!record || record.status === "stopped") {
        const loaded = await this.configLoader.load(context.path!);
        if (loaded.config.status !== "valid") {
          throw new WorkspaceServiceRequestError(
            404,
            "service_not_found",
            "Workspace service not found",
          );
        }
        const definition = loaded.definitions.find(
          (candidate) => candidate.name === input.serviceName,
        );
        if (!definition) {
          throw new WorkspaceServiceRequestError(
            404,
            "service_not_found",
            "Workspace service not found",
          );
        }
        const stopped = this.createStoppedRecord(
          input.parentProjectId,
          context,
          definition,
          loaded.config.revision,
        );
        this.records.set(stopped.identity.key, stopped);
        this.registerHostname(stopped.identity);
        return {
          accepted: false,
          service: this.toSnapshot(stopped, loaded.config.revision),
        };
      }

      record.status = "stopping";
      record.readinessAbort?.abort();
      record.readinessAbort = null;
      await record.process?.stop();
      record.process = null;
      record.targetPort = null;
      record.status = "stopped";
      record.exitCode = null;
      record.error = null;
      return {
        accepted: true,
        service: this.toSnapshot(record, record.configRevision),
      };
    } finally {
      release();
    }
  }

  resolveProxyRoute(hostname: string): WorkspaceServiceProxyRoute | null {
    const key = this.hostnameToKey.get(hostname.toLowerCase());
    if (!key) return null;
    const record = this.records.get(key);
    return {
      known: true,
      status: record?.status ?? "stopped",
      targetPort: record?.status === "ready" ? record.targetPort : null,
    };
  }

  async acquireDeletionGuard(projectIds: string[]): Promise<() => void> {
    const releases: Array<() => void> = [];
    try {
      for (const projectId of [...new Set(projectIds)].sort()) {
        releases.push(await this.contextMutex.acquire(projectId));
      }
      const blocking = Array.from(this.records.values()).find(
        (record) =>
          projectIds.includes(record.projectId) &&
          statusHasLiveProcess(record.status),
      );
      if (blocking) {
        throw new WorkspaceServiceRequestError(
          409,
          "start_blocked",
          `Workspace service ${blocking.definition.name} is ${blocking.status}`,
        );
      }
      for (const projectId of projectIds) {
        this.deletingProjectIds.add(projectId);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        for (const projectId of projectIds) {
          this.deletingProjectIds.delete(projectId);
        }
        for (const release of releases.reverse()) release();
      };
    } catch (error) {
      for (const release of releases.reverse()) release();
      throw error;
    }
  }

  async dispose(): Promise<void> {
    const live = Array.from(this.records.values()).filter(
      (record) => record.process,
    );
    await Promise.all(
      live.map((record) =>
        this.stop({
          parentProjectId: record.parentProjectId,
          projectId: record.projectId,
          serviceName: record.definition.name,
        }).catch(() => undefined),
      ),
    );
  }

  forgetContexts(projectIds: string[]): void {
    forgetWorkspaceServiceContexts(this.records, this.hostnameToKey, projectIds);
  }

  private resolveContext(
    parentProjectId: string,
    projectId: string,
  ): TerminalProjectContextRecord {
    const parent = this.terminalSessionManager
      .listProjects()
      .find((candidate) => candidate.id === parentProjectId);
    const context = this.terminalSessionManager.getProjectContext(projectId);
    if (!parent || !context || context.parentProjectId !== parentProjectId) {
      throw new WorkspaceServiceRequestError(
        404,
        "context_unavailable",
        "Terminal Project Context not found",
      );
    }
    if (context.availability !== "available" || !context.path) {
      throw new WorkspaceServiceRequestError(
        409,
        "context_unavailable",
        "Terminal Project Context path is unavailable",
      );
    }
    return context;
  }

  private requireProxyPort(): number {
    if (!this.proxyPort) {
      throw new WorkspaceServiceRequestError(
        503,
        "proxy_unavailable",
        "Workspace service proxy is not ready",
      );
    }
    return this.proxyPort;
  }

  private buildIdentity(
    parentProjectId: string,
    context: TerminalProjectContextRecord,
    serviceName: string,
  ): WorkspaceServiceIdentity {
    const parent = this.terminalSessionManager
      .listProjects()
      .find((candidate) => candidate.id === parentProjectId)!;
    return buildWorkspaceServiceIdentity({
      parentProjectId,
      projectId: context.projectId,
      projectName: parent.name,
      contextName: context.name,
      serviceName,
    });
  }

  private registerHostname(identity: WorkspaceServiceIdentity): void {
    const existingKey = this.hostnameToKey.get(identity.hostname);
    if (existingKey && existingKey !== identity.key) {
      throw new WorkspaceServiceRequestError(
        409,
        "proxy_unavailable",
        "Workspace service hostname collision",
      );
    }
    this.hostnameToKey.set(identity.hostname, identity.key);
  }

  private buildServiceUrls(
    parentProjectId: string,
    context: TerminalProjectContextRecord,
    definitions: WorkspaceServiceDefinition[],
    proxyPort: number,
  ): Map<string, string> {
    return new Map(
      definitions.map((definition) => {
        const identity = this.buildIdentity(
          parentProjectId,
          context,
          definition.name,
        );
        this.registerHostname(identity);
        return [
          definition.name,
          buildWorkspaceServiceUrl(identity.hostname, proxyPort),
        ];
      }),
    );
  }

  private synchronizeHostnames(
    parentProjectId: string,
    context: TerminalProjectContextRecord,
    loaded: WorkspaceServiceConfigLoadResult,
  ): void {
    if (loaded.config.status !== "valid") return;
    for (const definition of loaded.definitions) {
      const identity = this.buildIdentity(
        parentProjectId,
        context,
        definition.name,
      );
      this.registerHostname(identity);
      const existing = this.records.get(identity.key);
      if (!existing) {
        this.records.set(
          identity.key,
          this.createStoppedRecord(
            parentProjectId,
            context,
            definition,
            loaded.config.revision,
          ),
        );
      } else if (existing.status === "stopped") {
        existing.definition = definition;
        existing.configRevision = loaded.config.revision;
      }
    }
  }

  private createStoppedRecord(
    parentProjectId: string,
    context: TerminalProjectContextRecord,
    definition: WorkspaceServiceDefinition,
    configRevision: string,
  ): WorkspaceServiceRecord {
    return {
      identity: this.buildIdentity(parentProjectId, context, definition.name),
      parentProjectId,
      projectId: context.projectId,
      definition,
      configRevision,
      status: "stopped",
      targetPort: null,
      process: null,
      readinessAbort: null,
      generation: 0,
      exitCode: null,
      error: null,
    };
  }

  private toListResponse(
    parentProjectId: string,
    context: TerminalProjectContextRecord,
    loaded: WorkspaceServiceConfigLoadResult,
  ): WorkspaceServiceListResponse {
    const currentRevision =
      loaded.config.status === "valid" ? loaded.config.revision : null;
    const definitionNames = new Set(
      loaded.config.status === "valid"
        ? loaded.definitions.map((definition) => definition.name)
        : [],
    );
    const services: WorkspaceServiceSnapshot[] = [];
    if (loaded.config.status === "valid") {
      for (const definition of loaded.definitions) {
        const identity = this.buildIdentity(
          parentProjectId,
          context,
          definition.name,
        );
        const record = this.records.get(identity.key)!;
        services.push(this.toSnapshot(record, currentRevision));
      }
    }
    for (const record of this.records.values()) {
      if (
        record.projectId === context.projectId &&
        !definitionNames.has(record.definition.name) &&
        (statusHasLiveProcess(record.status) || record.status === "failed")
      ) {
        services.push(this.toSnapshot(record, currentRevision));
      }
    }
    return {
      parentProjectId,
      projectId: context.projectId,
      config: loaded.config,
      services,
    };
  }

  private toSnapshot(
    record: WorkspaceServiceRecord,
    currentRevision: string | null,
  ): WorkspaceServiceSnapshot {
    return {
      name: record.definition.name,
      command: record.definition.command,
      cwd: record.definition.cwd,
      healthCheckPath: record.definition.healthCheckPath,
      status: record.status,
      url: buildWorkspaceServiceUrl(
        record.identity.hostname,
        this.requireProxyPort(),
      ),
      targetPort: record.targetPort,
      configRevision: record.configRevision,
      staleConfig:
        currentRevision === null || currentRevision !== record.configRevision,
      exitCode: record.exitCode,
      error: record.error,
    };
  }

  private async settleStart(record: WorkspaceServiceRecord): Promise<void> {
    const process = record.process;
    const abort = record.readinessAbort;
    if (!process || !abort || record.targetPort === null) return;
    const generation = record.generation;
    try {
      await Promise.race([
        waitForWorkspaceServiceReady({
          port: record.targetPort,
          healthCheckPath: record.definition.healthCheckPath,
          signal: abort.signal,
        }),
        process.exit.then((exit) => Promise.reject(exit)),
      ]);
      if (record.generation !== generation || record.status !== "starting") {
        return;
      }
      record.status = "ready";
      record.readinessAbort = null;
      void process.exit.then((exit) =>
        this.handleProcessExit(record, generation, exit),
      );
    } catch (error) {
      if (record.generation !== generation || record.status !== "starting") return;
      await process.stop().catch(() => undefined);
      if (record.generation !== generation || record.status !== "starting") return;
      const exit =
        typeof error === "object" &&
        error !== null &&
        "requested" in error
          ? (error as OwnedWorkspaceServiceExit)
          : null;
      const portConflict = process.getOutputTail().includes("EADDRINUSE");
      record.status = "failed";
      record.process = null;
      record.readinessAbort = null;
      record.targetPort = null;
      record.exitCode = exit?.code ?? null;
      record.error = workspaceServiceError(
        portConflict
          ? "port_unavailable"
          : exit
            ? "process_exited"
            : "startup_timeout",
        portConflict
          ? "Workspace service port was claimed before the process could bind"
          : exit
            ? exitDescription(exit)
            : "Workspace service did not become ready within 30 seconds",
      );
    }
  }

  private handleProcessExit(
    record: WorkspaceServiceRecord,
    generation: number,
    exit: OwnedWorkspaceServiceExit,
  ): void {
    if (record.generation !== generation || record.status !== "ready") return;
    record.status = "failed";
    record.process = null;
    record.targetPort = null;
    record.exitCode = exit.code;
    record.error = workspaceServiceError("process_exited", exitDescription(exit));
  }
}
