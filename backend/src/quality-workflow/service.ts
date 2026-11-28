import { QUALITY_LIMITS, type QualityBatch, type QualityContextRequest, type QualityLedgerCommit } from "@runweave/shared/quality-workflow";
import type { QualityIssueHandoffService } from "./handoff";
import type { QualityStore } from "./store";
import { QualityStoreError } from "./store";
import { batchSchema, commitSchema, contextSchema, issueHandoffSchema } from "./validation";
export class QualityService {
  constructor(readonly backendId: string | null, readonly store: QualityStore | null, private projectForTerminal: (id: string) => string | null | undefined, private desktopConfigured = false, private handoffService?: QualityIssueHandoffService) {}
  capabilities() { return { enabled: Boolean(this.store), schemaVersion: 1, backendId: this.backendId, limits: QUALITY_LIMITS }; }
  private available() { if (!this.store) throw new QualityStoreError(503, "quality_store_unavailable"); return this.store; }
  private target(id: string) { if (id !== this.backendId) throw new QualityStoreError(409, "backend_mismatch"); }
  ingest(input: unknown) {
    if (Buffer.byteLength(JSON.stringify(input) ?? "") > QUALITY_LIMITS.batchBytes) throw new QualityStoreError(413, "batch_too_large");
    const parsed = batchSchema.safeParse(input); if (!parsed.success) throw new QualityStoreError(400, "invalid_batch");
    const batch: QualityBatch = parsed.data; this.target(batch.backendId);
    // Client claims cannot impersonate trusted local log readers.
    if (batch.client === "backend") throw new QualityStoreError(403, "reserved_source");
    const projects: Record<string, string | null> = {};
    const unknownTerminals = new Set<string>();
    for (const event of batch.events) if (event.terminalSessionId) {
      const project = this.projectForTerminal(event.terminalSessionId);
      if (project === undefined) {
        unknownTerminals.add(event.terminalSessionId);
        continue;
      }
      projects[event.terminalSessionId] = project;
    }
    if (unknownTerminals.size > 0) {
      throw new QualityStoreError(403, "terminal_not_owned", {
        terminalSessionIds: [...unknownTerminals],
      });
    }
    return this.available().ingest(batch, projects);
  }
  events(cursor?: string, limit = 200) { return this.available().events(cursor, limit); }
  context(input: unknown) {
    const parsed = contextSchema.safeParse(input); if (!parsed.success) throw new QualityStoreError(400, "invalid_context_request");
    const request: QualityContextRequest = parsed.data; this.target(request.backendId); return this.available().context(request);
  }
  async coverage() { const value = await this.available().coverage(); return { ...value, logSources: [{ kind: "backend", state: "configured" }, { kind: "desktop", state: this.desktopConfigured ? "configured" : "unconfigured" }] }; }
  ledger(issueId?: string) { return this.available().ledger(issueId); }
  latencyBaselines() { return this.available().latencyBaselines(); }
  commit(input: unknown) {
    const parsed = commitSchema.safeParse(input); if (!parsed.success) throw new QualityStoreError(400, "invalid_commit");
    const request: QualityLedgerCommit = parsed.data; this.target(request.backendId); return this.available().commit(request);
  }
  handoff(issueId: string, input: unknown) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(issueId)) throw new QualityStoreError(400, "invalid_issue_id");
    const parsed = issueHandoffSchema.safeParse(input);
    if (!parsed.success) throw new QualityStoreError(400, "invalid_handoff_request");
    if (!this.handoffService) throw new QualityStoreError(503, "quality_handoff_unavailable");
    return this.handoffService.execute(this.available(), issueId, parsed.data);
  }
}
