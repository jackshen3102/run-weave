import os from "node:os";
import { randomUUID } from "node:crypto";
import type {
  ResourceMonitorResponse,
  ResourceMonitorSettings,
  TerminateProcessRequest,
} from "@runweave/shared/resource-monitor";
import type { DeviceMonitorService } from "../device-monitor/service";
import type { RuntimeStatusWorkspaceServiceManager as WorkspaceServiceManager } from "../runtime-status/workspace-service-manager";
import { ResourceMonitorStore } from "./store";
import { createResourceSampler, type ResourceSample } from "./sampler";
import { ResourceObservations } from "./observations";
import { ProcessActions, ResourceRequestError } from "./process-actions";

export class ResourceMonitorService {
  private readonly streamId = randomUUID();
  private revision = 0;
  private latest: ResourceSample | null = null;
  private timer?: NodeJS.Timeout;
  private flight: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private stopped = false;
  private failed = false;
  private observedMonotonic: number | null = null;
  private observations = new ResourceObservations();
  private unsubscribe: () => void;
  readonly actions: ProcessActions;
  readonly hostId: string;
  constructor(
    readonly store: ResourceMonitorStore,
    private device: DeviceMonitorService,
    private manager: WorkspaceServiceManager,
    private sampler = createResourceSampler(),
    private clock = () => performance.now(),
  ) {
    this.hostId = device.snapshot().hostId;
    this.actions = new ProcessActions(manager, (id) =>
      this.store.snapshot().settings.monitorEnabled
        ? this.latest?.identities.get(id)
        : undefined,
    );
    this.unsubscribe = device.subscribe((snapshot) => {
      if (
        snapshot.sampleStatus !== "ok" ||
        snapshot.battery.powerSource !== "battery"
      )
        this.observations.reset("energy");
    });
  }
  start(): void {
    if (this.timer || this.stopped || process.platform !== "darwin") return;
    this.timer = setInterval(() => void this.sample(), 60_000);
    this.timer.unref();
    void this.sample();
  }
  sample(): Promise<void> {
    if (this.flight) return this.flight;
    if (
      this.stopped ||
      !this.store.snapshot().settings.monitorEnabled ||
      process.platform !== "darwin"
    )
      return Promise.resolve();
    this.flight = this.collect().finally(() => {
      this.flight = null;
    });
    return this.flight;
  }
  private async collect(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const battery = this.device.snapshot();
      const sample = await this.sampler(
        controller.signal,
        battery.sampleStatus === "ok" &&
          (battery.sampleAgeMs ?? Infinity) <= 180_000
          ? battery.battery
          : null,
      );
      if (
        controller.signal.aborted ||
        this.stopped ||
        !this.store.snapshot().settings.monitorEnabled
      )
        return;
      for (const identity of sample.identities.values()) {
        const service = this.manager.findOwnedProcess(identity.pid);
        if (service && identity.uid === process.getuid?.()) {
          identity.actionKind = "stop_service";
          identity.actionReason = undefined;
          const item = sample.snapshot.processes.find(
            (p) => p.processInstanceId === identity.processInstanceId,
          );
          if (item) {
            item.actionKind = "stop_service";
            item.actionReason = undefined;
            item.serviceName = service.serviceName;
          }
        }
      }
      this.revision++;
      this.latest = sample;
      this.failed = false;
      this.observedMonotonic = this.clock();
      await this.store.update((state) =>
        this.observations.evaluate(sample, state, this.hostId, this.clock()),
      );
    } catch {
      if (!this.stopped && this.store.snapshot().settings.monitorEnabled)
        this.failed = true;
      this.observations.reset();
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
    }
  }
  snapshot(local: boolean): ResourceMonitorResponse {
    const state = this.store.snapshot();
    const stale =
      this.observedMonotonic !== null &&
      this.clock() - this.observedMonotonic > 180_000;
    const status =
      process.platform !== "darwin"
        ? "unsupported"
        : !state.settings.monitorEnabled
          ? "disabled"
          : this.failed
            ? "error"
            : !this.latest
              ? "warming-up"
              : stale
                ? "stale"
                : "ok";
    const battery = this.device.snapshot();
    const onBattery =
      battery.sampleStatus === "ok" &&
      battery.battery.powerSource === "battery" &&
      (battery.sampleAgeMs ?? Infinity) <= 180_000;
    const snapshot = this.latest ? structuredClone(this.latest.snapshot) : null;
    if (snapshot) {
      snapshot.apps.sort(
        (a, b) =>
          (b.energyImpact ?? -1) - (a.energyImpact ?? -1) ||
          (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1),
      );
      if (!local || status !== "ok")
        for (const item of snapshot.processes) {
          item.actionKind = "readonly";
          item.actionReason = !local ? "仅本机直连可结束进程" : "需要新鲜采样";
        }
    }
    return {
      hostId: this.hostId,
      hostName: os.hostname(),
      streamId: this.streamId,
      revision: this.revision,
      sampleAgeMs:
        this.observedMonotonic === null
          ? null
          : Math.max(0, this.clock() - this.observedMonotonic),
      status,
      snapshot,
      settings: state.settings,
      alerts:
        status === "ok" && state.settings.alertsEnabled
          ? state.alerts
              .filter(
                (alert) =>
                  alert.active &&
                  this.observations.visible(alert.appKey, alert.ruleId) &&
                  alert.snoozedUntil <= Date.now() &&
                  (state.snoozes[alert.appKey] ?? 0) <= Date.now() &&
                  (alert.ruleId !== "energy" || onBattery),
              )
              .slice(-50)
          : [],
      coverage: this.latest?.coverage ?? {
        knownProcesses: 0,
        matchedProcesses: 0,
        complete: false,
      },
      cpuSource: "native-minute-delta",
      canTerminate: local && status === "ok",
    };
  }
  async settings(
    input: ResourceMonitorSettings,
  ): Promise<ResourceMonitorSettings> {
    let wasEnabled = false;
    const result = await this.store.update((state) => {
      wasEnabled = state.settings.monitorEnabled;
      if (input.revision !== state.settings.revision)
        throw new ResourceRequestError(
          409,
          "revision_conflict",
          "设置已由其他页面修改，请重新打开",
        );
      state.settings = { ...input, revision: input.revision + 1 };
      return state.settings;
    });
    this.observations.reset();
    if (!result.monitorEnabled) {
      this.controller?.abort();
      await this.flight;
    } else if (!wasEnabled) void this.sample();
    return result;
  }
  async snooze(alertId: string): Promise<void> {
    await this.store.update((state) => {
      const alert = state.alerts.find(
        (item) => item.alertId === alertId && item.hostId === this.hostId,
      );
      if (!alert)
        throw new ResourceRequestError(404, "unknown_alert", "提醒已过期");
      const until = Date.now() + 3_600_000;
      state.snoozes[alert.appKey] = until;
      for (const item of state.alerts)
        if (item.appKey === alert.appKey) item.snoozedUntil = until;
    });
  }
  terminate(
    id: string,
    input: TerminateProcessRequest,
    session: string,
    authorized: () => boolean,
  ) {
    if (
      !this.store.snapshot().settings.monitorEnabled ||
      this.failed ||
      this.observedMonotonic === null ||
      this.clock() - this.observedMonotonic > 180_000
    )
      throw new ResourceRequestError(403, "disabled", "资源监控不可用");
    return this.actions.terminate(id, input, session, authorized);
  }
  async dispose(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.unsubscribe();
    this.controller?.abort();
    await this.actions.dispose();
    await this.flight;
    await this.store.close();
  }
}
