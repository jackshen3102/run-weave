import { useEffect } from "react";
import { QUALITY_LIMITS, type QualityEvent } from "@runweave/shared/quality-workflow";
import type { DiagnosticLogRecord } from "@runweave/shared/diagnostic-logs";
import { setActionDiagnosticObserver } from "../../lib/action-diagnostics";
import { qualityApi } from "../../services/quality-workflow";
import { HttpError } from "../../services/http";
import { QualityQueue } from "./quality-queue";
const uploaders = new Map<string, QualityUploader>();
class QualityUploader {
  private queue?: QualityQueue; private timer?: ReturnType<typeof setTimeout>; private stopped = false; private busy = false; private failures = 0;
  constructor(private apiBase: string, private token: string) {}
  async start() {
    if (this.timer) clearTimeout(this.timer);
    try {
      const capability = await qualityApi(this.apiBase, this.token).capabilities();
      if (this.stopped || !capability.enabled || capability.schemaVersion !== 1 || !capability.backendId) return;
      const backendId = capability.backendId;
      this.queue = await navigator.locks.request(`runweave.quality.v1.${backendId}`, () => new QualityQueue(backendId)); this.schedule(0);
    } catch { if (!this.stopped) this.timer = setTimeout(() => { void this.start(); }, 60_000); }
  }
  observer(terminalSessionId?: string, attemptId?: string) {
    // Freeze the queue and backend at operation start, even if the UI switches computers.
    const queue = this.queue;
    if (!queue) return undefined;
    return (record: DiagnosticLogRecord) => {
      const d = record.details as Record<string, unknown>;
      const event: Omit<QualityEvent, "seq"> = { at: record.at, action: record.message as QualityEvent["action"], stage: d.stage as QualityEvent["stage"],
        operationId: d.operationId as string, launchId: d.launchId as string, elapsedMs: d.elapsedMs as number,
        appVersion: d.app_version as string, buildId: d.build_id as string, sourceRevision: d.source_revision as string, sourceState: d.source_state as QualityEvent["sourceState"],
        ...(terminalSessionId ? { terminalSessionId } : {}), ...(attemptId ? { attemptId } : {}),
        ...(d.failureCode ? { failureCode: d.failureCode as string } : {}), ...(typeof d.status === "number" ? { status: d.status } : {}), ...(d.relatedOperationId ? { relatedOperationId: d.relatedOperationId as string } : {}) };
      void queue.enqueue(event).then(() => { if (queue.snapshot().events.length >= 64 || event.stage === "failed") this.schedule(1000); }).catch(() => { /* Previous durable data remains available. */ });
    };
  }
  private schedule(delay: number) { if (this.stopped) return; if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => { void this.flush(); }, delay); }
  private async flush() {
    if (this.stopped || this.busy || !this.queue) return;
    const snapshot = this.queue.snapshot(); if (snapshot.blocked) return;
    if (!snapshot.events.length && !snapshot.droppedRanges.length) { this.schedule(30_000); return; }
    this.busy = true;
    try {
      const events = snapshot.events.slice(0, QUALITY_LIMITS.batchEvents); const droppedRanges = snapshot.droppedRanges.slice(0, 128);
      const sentThrough = Math.max(0, ...events.map(e => e.seq), ...droppedRanges.map(r => r.through));
      const receipt = await qualityApi(this.apiBase, this.token).upload({ schemaVersion: 1, backendId: snapshot.backendId, sourceId: snapshot.sourceId, streamId: snapshot.streamId, client: window.electronAPI?.isElectron ? "desktop" : "web", uploadedAt: new Date().toISOString(), events, droppedRanges });
      await this.queue.acknowledge(receipt.ackThrough, sentThrough); this.failures = 0;
      this.schedule(this.queue.snapshot().events.length ? 1100 : 30_000);
    } catch (error) {
      if (error instanceof HttpError && [400, 409, 413].includes(error.status)) await this.queue.block(`HTTP_${error.status}`);
      else if (error instanceof HttpError && [401, 403, 404].includes(error.status)) this.schedule(60_000);
      else this.schedule(Math.min(300_000, 1000 * 2 ** Math.min(8, ++this.failures)) + Math.random() * 1000);
    } finally { this.busy = false; }
  }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
}
setActionDiagnosticObserver((action, context, operationId) => {
  if (action !== "terminal_send" && action !== "connection_recover" || !context?.apiBase) return undefined;
  return uploaders.get(context.apiBase)?.observer(context.terminalSessionId, action === "connection_recover" ? operationId : undefined);
});
export function useQualityUploader(apiBase: string, token: string | null | undefined) {
  useEffect(() => {
    if (!token) return;
    const uploader = new QualityUploader(apiBase, token); uploaders.set(apiBase, uploader); void uploader.start();
    const resume = () => { if (document.visibilityState === "visible") void uploader.start(); };
    window.addEventListener("online", resume); document.addEventListener("visibilitychange", resume);
    return () => { if (uploaders.get(apiBase) === uploader) uploaders.delete(apiBase); uploader.stop(); window.removeEventListener("online", resume); document.removeEventListener("visibilitychange", resume); };
  }, [apiBase, token]);
}
