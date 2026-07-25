import crypto from "node:crypto";
import type { EvolutionAnalysisOrchestrator } from "./analysis/orchestrator";
import type { EvolutionFoundationStore } from "./foundation-store";
import type { EvolutionEvidenceReconciler } from "./knowledge/evidence-reconciler";
import type { EvolutionService } from "./service";

const RECOVERY_INTERVAL_MS = 5_000;
const LEASE_TTL_MS = 45_000;
const HEARTBEAT_INTERVAL_MS = 10_000;

export class EvolutionRuntime {
  private recoveryTimer: NodeJS.Timeout | null = null;
  private maintenanceRunning = false;
  private activeExecution: Promise<void> | null = null;
  private activeAbortController: AbortController | null = null;
  private controlPlaneBaseUrl: string | null = null;
  private readonly ownerId = `evolution-runtime:${process.pid}:${crypto.randomUUID()}`;

  constructor(
    private readonly store: EvolutionFoundationStore | null,
    private readonly service: EvolutionService,
    private readonly orchestrator: EvolutionAnalysisOrchestrator | null,
    private readonly onError: (error: unknown) => void,
    private readonly evidenceReconciler: EvolutionEvidenceReconciler | null = null,
  ) {}

  start(controlPlaneBaseUrl: string): void {
    if (!this.store || this.recoveryTimer) return;
    this.controlPlaneBaseUrl = controlPlaneBaseUrl;
    this.recoveryTimer = setInterval(
      () => this.runMaintenance(),
      RECOVERY_INTERVAL_MS,
    );
    this.recoveryTimer.unref();
    this.runMaintenance();
  }

  async dispose(): Promise<void> {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    this.activeAbortController?.abort("evolution_runtime_shutdown");
    await this.activeExecution?.catch(() => undefined);
  }

  private runMaintenance(): void {
    if (!this.store || this.maintenanceRunning) return;
    this.maintenanceRunning = true;
    const now = new Date();
    void this.store
      .recoverExpiredRuns(now.toISOString())
      .then(() =>
        this.orchestrator?.cleanupOrphanedTemporaryDirectories(),
      )
      .then(() => this.service.materializeDueSchedules(now))
      .then(() => this.evidenceReconciler?.reconcile())
      .then(() => this.claimAndExecute())
      .catch(this.onError)
      .finally(() => {
        this.maintenanceRunning = false;
      });
  }

  private async claimAndExecute(): Promise<void> {
    if (
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
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    let heartbeatRunning = false;
    const heartbeat = setInterval(() => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      void this.refreshClaim(claim, abortController)
        .catch((error) => {
          abortController.abort("evolution_lease_lost");
          this.onError(error);
        })
        .finally(() => {
          heartbeatRunning = false;
        });
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
  }
}
