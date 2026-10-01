import { randomUUID } from "node:crypto";
import type { ResourceRule } from "@runweave/shared/resource-monitor";
import type { ResourceSample } from "./sampler";
import type { ResourceState } from "./store";

interface Observation {
  samples: { at: number; tick: number; value: number }[];
  recovery: number;
  lastAt: number;
  instances: string;
}
export class ResourceObservations {
  private observations = new Map<string, Observation>();
  private ready = new Set<string>();
  reset(rule?: ResourceRule): void {
    if (!rule) {
      this.observations.clear();
      this.ready.clear();
      return;
    }
    for (const key of this.observations.keys())
      if (key.endsWith(`:${rule}`)) {
        this.observations.delete(key);
        this.ready.delete(key);
      }
  }
  visible(appKey: string, ruleId: ResourceRule): boolean {
    return this.ready.has(`${appKey}:${ruleId}`);
  }
  evaluate(
    sample: ResourceSample,
    state: ResourceState,
    hostId: string,
    tick: number,
  ): void {
    const now = sample.snapshot.sampledAt;
    state.alerts = state.alerts
      .filter((alert) => now - alert.createdAt < 86_400_000)
      .slice(-200);
    for (const record of [state.cooldowns, state.snoozes])
      for (const [key, until] of Object.entries(record))
        if (until <= now) delete record[key];
    const battery = sample.snapshot.battery;
    const onBattery = battery.available && battery.powerSource === "battery";
    const liveApps = new Set(sample.snapshot.apps.map((app) => app.appKey));
    for (const alert of state.alerts) {
      if (
        (sample.processListComplete ?? sample.coverage.complete) &&
        !liveApps.has(alert.appKey)
      )
        alert.active = false;
    }
    for (const app of sample.snapshot.apps)
      for (const ruleId of ["energy", "memory"] as ResourceRule[]) {
        const key = `${app.appKey}:${ruleId}`;
        const instances = sample.snapshot.processes
          .filter((process) => process.appKey === app.appKey)
          .map((process) => process.processInstanceId ?? String(process.pid))
          .sort()
          .join(":");
        const observation = this.observations.get(key) ?? {
          samples: [],
          recovery: 0,
          lastAt: tick,
          instances,
        };
        const alert = [...state.alerts]
          .reverse()
          .find(
            (item) =>
              item.appKey === app.appKey &&
              item.ruleId === ruleId &&
              item.active,
          );
        const value = ruleId === "energy" ? app.energyImpact : app.memoryMb;
        const threshold = ruleId === "energy" ? 100 : 4096;
        const valid =
          state.settings.alertsEnabled &&
          app.coverage === "complete" &&
          Number.isFinite(value) &&
          (ruleId !== "energy" || onBattery);
        if (
          !valid ||
          tick - observation.lastAt > 90_000 ||
          tick < observation.lastAt ||
          observation.instances !== instances
        ) {
          observation.samples = [];
          observation.recovery = 0;
          this.ready.delete(key);
        }
        observation.lastAt = tick;
        observation.instances = instances;
        if (!valid) {
          this.observations.delete(key);
          continue;
        }
        // Keep windows for high/recovering candidates, not every idle application.
        // Otherwise the bounded map would evict real candidates on busy Macs.
        if (value! < threshold && !alert && !this.observations.has(key))
          continue;
        if (value! >= threshold) {
          observation.recovery = 0;
          observation.samples.push({ at: now, tick, value: value! });
          observation.samples = observation.samples.slice(-6);
          const first = observation.samples[0]!;
          if (
            observation.samples.length === 6 &&
            tick - first.tick >= 300_000
          ) {
            this.ready.add(key);
            const evidence = {
              firstAt: first.at,
              lastAt: now,
              mean:
                observation.samples.reduce(
                  (sum, entry) => sum + entry.value,
                  0,
                ) / 6,
              sampleCount: 6,
            };
            if (alert) Object.assign(alert, evidence);
            else if (
              (state.cooldowns[key] ?? 0) <= now &&
              (state.snoozes[app.appKey] ?? 0) <= now
            ) {
              state.alerts.push({
                alertId: randomUUID(),
                hostId,
                appKey: app.appKey,
                appName: app.appName,
                ruleId,
                ...evidence,
                active: true,
                snoozedUntil: 0,
                createdAt: now,
              });
              state.cooldowns[key] = now + 30 * 60_000;
            }
          }
        } else {
          observation.samples = [];
          observation.recovery =
            value! < threshold * 0.8 ? observation.recovery + 1 : 0;
          if (alert && observation.recovery >= 3) alert.active = false;
        }
        this.observations.set(key, observation);
      }
    for (const [key, observation] of this.observations)
      if (tick - observation.lastAt > 180_000) {
        this.observations.delete(key);
        this.ready.delete(key);
      }
    if (this.observations.size > 200) {
      const keys = [...this.observations]
        .sort((a, b) => b[1].lastAt - a[1].lastAt)
        .slice(200)
        .map(([key]) => key);
      for (const key of keys) {
        this.observations.delete(key);
        this.ready.delete(key);
      }
    }
    state.alerts = state.alerts.slice(-200);
  }
}
