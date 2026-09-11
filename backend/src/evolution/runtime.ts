import crypto from "node:crypto";
import type { EvolutionAnalysisOrchestrator } from "./analysis/orchestrator";
import type { EvolutionFoundationStore } from "./foundation-store";
import type { EvolutionEvidenceReconciler } from "./knowledge/evidence-reconciler";
import type { EvolutionService } from "./service";

const RECOVERY_INTERVAL_MS = 5_000;
const LEASE_TTL_MS = 45_000;
const HEARTBEAT_INTERVAL_MS = 10_000;

export class EvolutionRuntime {
  private readonly startedAt = Date.now();
  private recoveryTimer: NodeJS.Timeout | null = null;
  private maintenanceRunning = false;
  private maintenance: Promise<void> | null = null;
  private stopping = false;
  private disposal: Promise<void> | null = null;
  private readonly heartbeats = new Set<Promise<void>>();
  private activeExecution: Promise<void> | null = null;
  private activeAbortController: AbortController | null = null;
  private controlPlaneBaseUrl: string | null = null;
  private lastMaintenanceStartedAt: number | null = null;
  private lastMaintenanceCompletedAt: number | null = null;
  private lastMaintenanceFailedAt: number | null = null;
  private lastLeaseHeartbeatAt: number | null = null;
  private consecutiveMaintenanceFailures = 0;
  private readonly ownerId = `evolution-runtime:${process.pid}:${crypto.randomUUID()}`;

  constructor(
    private readonly store: EvolutionFoundationStore | null,
    private readonly service: EvolutionService,
    private readonly orchestrator: EvolutionAnalysisOrchestrator | null,
    private readonly onError: (error: unknown) => void,
    private readonly evidenceReconciler: EvolutionEvidenceReconciler | null = null,
  ) {}

  start(controlPlaneBaseUrl: string): void {
    if (!this.store || this.recoveryTimer || this.stopping) return;
    this.controlPlaneBaseUrl = controlPlaneBaseUrl;
    this.recoveryTimer = setInterval(
      () => this.runMaintenance(),
      RECOVERY_INTERVAL_MS,
    );
    this.recoveryTimer.unref();
    this.runMaintenance();
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.stopping = true;
      if (this.recoveryTimer) clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
      this.activeAbortController?.abort("evolution_runtime_shutdown");
      this.disposal = this.drain();
    }
    return this.disposal;
  }

  private async drain(): Promise<void> {
    await this.maintenance;
    this.activeAbortController?.abort("evolution_runtime_shutdown");
    await this.activeExecution?.catch(() => undefined);
    await Promise.allSettled([...this.heartbeats]);
  }

  getStatusSnapshot() {
    return {
      enabled: this.store !== null,
      startedAt: this.startedAt,
      maintenanceRunning: this.maintenanceRunning,
      activeExecution: this.activeExecution !== null,
      lastMaintenanceStartedAt: this.lastMaintenanceStartedAt,
      lastMaintenanceCompletedAt: this.lastMaintenanceCompletedAt,
      lastMaintenanceFailedAt: this.lastMaintenanceFailedAt,
      lastLeaseHeartbeatAt: this.lastLeaseHeartbeatAt,
      consecutiveMaintenanceFailures: this.consecutiveMaintenanceFailures,
    };
  }

  private runMaintenance(): void {
    if (!this.store || this.maintenanceRunning || this.stopping) return;
    this.maintenanceRunning = true;
    this.lastMaintenanceStartedAt = Date.now();
    const now = new Date();
    this.maintenance = this.store
      .recoverExpiredRuns(now.toISOString())
      .then(() =>
        this.orchestrator?.cleanupOrphanedTemporaryDirectories(),
      )
      .then(() => this.service.materializeDueSchedules(now))
      .then(() => this.evidenceReconciler?.reconcile())
      .then(() => this.claimAndExecute())
      .then(() => {
        this.lastMaintenanceCompletedAt = Date.now();
        this.consecutiveMaintenanceFailures = 0;
      })
      .catch((error) => {
        this.lastMaintenanceFailedAt = Date.now();
        this.consecutiveMaintenanceFailures += 1;
        this.onError(error);
      })
      .finally(() => {
        this.maintenanceRunning = false;
        this.maintenance = null;
      });
  }

  private async claimAndExecute(): Promise<void> {
    if (
      this.stopping ||
      !this.store ||
      !this.orchestrator ||
      !this.controlPlaneBaseUrl ||
      this.activeExecution
    ) {
      return;
    }
    const claim = await this.store.claimNextRun({
      ownerId: this.ownerId,
      now: new Date().toISOString(),
      leaseTtlMs: LEASE_TTL_MS,
    });
    if (!claim) return;
    this.lastLeaseHeartbeatAt = Date.now();
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    if (this.stopping) abortController.abort("evolution_runtime_shutdown");
    let heartbeatRunning = false;
    const heartbeat = setInterval(() => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      const task = this.refreshClaim(claim, abortController)
        .catch((error) => {
          abortController.abort("evolution_lease_lost");
          this.onError(error);
        })
        .finally(() => {
          heartbeatRunning = false;
          this.heartbeats.delete(task);
        });
      this.heartbeats.add(task);
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
    this.activeExecution = this.orchestrator
      .execute(
        claim,
        this.controlPlaneBaseUrl,
        abortController.signal,
      )
      .catch(this.onError)
      .finally(() => {
        clearInterval(heartbeat);
        this.activeAbortController = null;
        this.activeExecution = null;
        this.runMaintenance();
      });
  }

  private async refreshClaim(
    claim: NonNullable<
      Awaited<ReturnType<EvolutionFoundationStore["claimNextRun"]>>
    >,
    abortController: AbortController,
  ): Promise<void> {
    if (!this.store) return;
    const run = await this.store.getRun(claim.run.runId);
    if (!run || run.stage === "cancelled") {
      abortController.abort("evolution_run_cancelled");
      return;
    }
    await this.store.heartbeatRunClaim({
      ownerId: claim.ownerId,
      fencingToken: claim.fencingToken,
      now: new Date().toISOString(),
      leaseTtlMs: LEASE_TTL_MS,
    });
    this.lastLeaseHeartbeatAt = Date.now();
  }
}
