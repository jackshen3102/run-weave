import { randomUUID } from "node:crypto";
import type { ServerMaintenanceLease } from "@runweave/shared/server-management";

const LEASE_MS = 120_000;

/** Pauses new claims synchronously before waiting for an in-flight scheduler pass. */
export class ServerMaintenance {
  private lease: { id: string; owner: string; expires: number } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly drainClaims: () => Promise<void>,
    private readonly affected: () => ServerMaintenanceLease["affectedRuns"],
    private readonly resume: () => void,
  ) {}

  get paused(): boolean {
    return !!this.lease && this.lease.expires > Date.now();
  }

  async acquire(owner: string): Promise<ServerMaintenanceLease> {
    if (this.paused) throw new Error("MAINTENANCE_BUSY");
    this.lease = { id: randomUUID(), owner, expires: Date.now() + LEASE_MS };
    const id = this.lease.id;
    this.armTimer();
    await this.drainClaims();
    return this.renew(owner, id);
  }

  renew(owner: string, id: string): ServerMaintenanceLease {
    if (!this.paused || this.lease?.id !== id || this.lease.owner !== owner)
      throw new Error("MAINTENANCE_LEASE_INVALID");
    this.lease.expires = Date.now() + LEASE_MS;
    this.armTimer();
    return {
      leaseId: id,
      expiresAt: new Date(this.lease.expires).toISOString(),
      affectedRuns: this.affected(),
    };
  }

  release(owner: string, id: string): void {
    this.renew(owner, id);
    this.dispose();
    this.resume();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.lease = null;
  }

  private armTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.dispose();
      this.resume();
    }, LEASE_MS);
    this.timer.unref();
  }
}
