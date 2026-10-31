import type { ScreenRecordingMethod, ScreenRecordingStatus, ScreenRecordingView } from "@runweave/shared/screen-recording";
import { ScreenRecordingClient, ScreenRecordingFailure } from "./client";

export interface ScreenRecordingPrincipal { sessionID: string; connectionID: string }
interface Owner extends ScreenRecordingPrincipal { epoch: string; deviceID: string; expiresAt: number }
export class ScreenRecordingService {
  private readonly client = new ScreenRecordingClient();
  private readonly owners = new Map<string, Owner>();
  async execute(method: ScreenRecordingMethod, params: Record<string, string | number>, principal: ScreenRecordingPrincipal, signal?: AbortSignal) {
    for (const [id, owner] of this.owners) if (owner.expiresAt <= Date.now()) this.owners.delete(id);
    const viewID = typeof params.viewID === "string" ? params.viewID : undefined;
    if (viewID) {
      const owner = this.owners.get(viewID);
      // An absent view has nothing to release; do not forward an unowned ID.
      if (!owner && method === "closeView") return { header: { contentType: "application/json" as const }, body: Buffer.from(JSON.stringify({ released: true })) };
      if (!owner || owner.sessionID !== principal.sessionID || owner.connectionID !== principal.connectionID) throw new ScreenRecordingFailure(404, "NOT_FOUND");
    }
    try {
      const result = await this.client.request(method, params, signal);
      if (viewID) {
        const owner = this.owners.get(viewID);
        if (!owner || owner.epoch !== result.header.serverEpoch) { this.owners.delete(viewID); throw new ScreenRecordingFailure(409, "VIEW_EXPIRED"); }
        if (method === "closeView") this.owners.delete(viewID);
      }
      if (method === "openView") {
        const view = JSON.parse(result.body.toString("utf8")) as ScreenRecordingView;
        if (typeof view.viewID !== "string" || view.serverEpoch !== result.header.serverEpoch || typeof view.deviceID !== "string" || !Number.isSafeInteger(view.expiresAt)) throw new ScreenRecordingFailure(503, "INVALID_PROTOCOL");
        this.owners.set(view.viewID, { ...principal, epoch: view.serverEpoch, deviceID: view.deviceID, expiresAt: view.expiresAt });
      }
      return result;
    } catch (error) {
      if (method === "status" && error instanceof ScreenRecordingFailure && ["NOT_RUNNING", "UNSUPPORTED", "INCOMPATIBLE"].includes(error.code)) {
        const status: ScreenRecordingStatus = { version: 1, availability: error.code === "UNSUPPORTED" ? "unsupported" : error.code === "INCOMPATIBLE" ? "incompatible" : "notRunning" };
        return { header: { contentType: "application/json" as const }, body: Buffer.from(JSON.stringify(status)) };
      }
      throw error;
    }
  }
  dispose(): void { this.client.dispose(); this.owners.clear(); }
}
