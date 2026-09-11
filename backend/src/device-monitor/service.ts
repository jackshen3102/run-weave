import { randomUUID } from "node:crypto";
import {
  DEVICE_SAMPLE_INTERVAL_MS,
  unknownBattery,
  type DeviceStatusSnapshot,
} from "@runweave/shared/device-status";
import { sampleBattery, type BatterySampler } from "./sampler";
import { DeviceMonitorStore } from "./store";

export class DeviceMonitorService {
  private snapshotValue: DeviceStatusSnapshot;
  private observedMonotonic: number | null = null;
  private timer?: NodeJS.Timeout;
  private flight: Promise<void> | null = null;
  private controller = new AbortController();
  private listeners = new Set<(snapshot: DeviceStatusSnapshot) => void>();

  constructor(
    readonly store: DeviceMonitorStore,
    private sampler: BatterySampler = sampleBattery,
  ) {
    this.snapshotValue = {
      protocolVersion: 1,
      hostId: store.snapshot().hostId,
      streamId: randomUUID(),
      revision: 0,
      sampleStatus: "pending",
      observedAt: null,
      sampleAgeMs: null,
      battery: unknownBattery(),
    };
  }

  start(): void {
    if (this.timer || this.controller.signal.aborted) return;
    this.timer = setInterval(
      () => void this.sample(),
      DEVICE_SAMPLE_INTERVAL_MS,
    );
    this.timer.unref();
    void this.sample();
  }

  snapshot(): DeviceStatusSnapshot {
    return {
      ...this.snapshotValue,
      battery: { ...this.snapshotValue.battery },
      sampleAgeMs:
        this.observedMonotonic === null
          ? null
          : Math.max(0, performance.now() - this.observedMonotonic),
    };
  }

  subscribe(listener: (snapshot: DeviceStatusSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  sample(): Promise<void> {
    if (this.flight) return this.flight;
    if (this.controller.signal.aborted) return Promise.resolve();
    this.flight = this.collect().finally(() => {
      this.flight = null;
    });
    return this.flight;
  }

  private async collect(): Promise<void> {
    try {
      const battery = await this.sampler(this.controller.signal);
      if (this.controller.signal.aborted) return;
      this.snapshotValue.battery = battery ?? unknownBattery();
      this.snapshotValue.sampleStatus = battery ? "ok" : "unsupported";
      this.snapshotValue.observedAt = battery ? new Date().toISOString() : null;
      this.observedMonotonic = battery ? performance.now() : null;
    } catch {
      if (this.controller.signal.aborted) return;
      this.snapshotValue.sampleStatus = "error";
    }
    this.snapshotValue.revision += 1;
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot());
      } catch {
        /* One subscriber cannot stop sampling or the other subscribers. */
      }
    }
  }

  async dispose(): Promise<void> {
    clearInterval(this.timer);
    this.controller.abort();
    await this.flight;
    this.listeners.clear();
    await this.store.close();
  }
}
