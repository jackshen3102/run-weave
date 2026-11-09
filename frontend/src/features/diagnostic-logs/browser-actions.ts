import { beginDiagnosticAction } from "../../lib/action-diagnostics";

type Operation = ReturnType<typeof beginDiagnosticAction>;

/** One current navigation per tab; closing the controller releases the map with it. */
export class BrowserActionDiagnostics {
  private pending = new Map<string, Operation>();

  begin(tabId: string): Operation {
    this.pending.get(tabId)?.stage("cancelled");
    this.pending.delete(tabId);
    return beginDiagnosticAction("browser_open");
  }

  async request<T>(tabId: string, operation: Operation, request: () => Promise<T>, isCancelled: (error: unknown) => boolean): Promise<T> {
    this.pending.set(tabId, operation);
    operation.stage("request_started");
    try {
      const result = await request();
      operation.stage("response_received");
      return result;
    } catch (error) {
      if (this.pending.get(tabId) === operation) {
        operation.stage(isCancelled(error) ? "cancelled" : "failed", error);
        this.pending.delete(tabId);
      }
      throw error;
    }
  }

  updated(tabId: string, loading: boolean, failed: boolean): void {
    if (loading) return;
    this.pending.get(tabId)?.stage(failed ? "failed" : "loaded");
    this.pending.delete(tabId);
  }
}
