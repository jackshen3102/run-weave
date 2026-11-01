import type { ScreenRecordingMethod, ScreenRecordingPackage, ScreenRecordingStatus, ScreenRecordingView } from "@runweave/shared/screen-recording";
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
  async *download(viewID: string, principal: ScreenRecordingPrincipal, signal: AbortSignal): AsyncGenerator<Buffer> {
    let result;
    try { result = await this.execute("packageManifest", { viewID }, principal, signal); }
    catch (error) {
      if (error instanceof ScreenRecordingFailure && error.code === "INVALID_ARGUMENT") throw new ScreenRecordingFailure(409, "UPDATE_REQUIRED");
      throw error;
    }
    const manifest = JSON.parse(result.body.toString("utf8")) as ScreenRecordingPackage;
    if (result.body.length > 1024 * 1024 || manifest.version !== 1 || manifest.viewID !== viewID || !("serverEpoch" in result.header) || manifest.serverEpoch !== result.header.serverEpoch ||
        !Number.isSafeInteger(manifest.expiresAt) || manifest.expiresAt <= Date.now() || !Array.isArray(manifest.assets) || manifest.assets.length > 900 ||
        !Array.isArray(manifest.frames) || manifest.frames.length > 900) throw new ScreenRecordingFailure(503, "INVALID_PROTOCOL");
    let total = 0;
    for (const asset of manifest.assets) {
      if (!/^[0-9a-f-]{36}$/i.test(asset.id) || !Number.isSafeInteger(asset.byteLength) || asset.byteLength <= 0 || !/^[0-9a-f]{64}$/.test(asset.sha256)) throw new ScreenRecordingFailure(503, "INVALID_PROTOCOL");
      total += asset.byteLength;
    }
    if (total > 128 * 1024 * 1024 || new Set(manifest.assets.map(asset => asset.id)).size !== manifest.assets.length) throw new ScreenRecordingFailure(503, "INVALID_PROTOCOL");
    const length = Buffer.alloc(4); length.writeUInt32BE(result.body.length);
    yield Buffer.concat([length, result.body]);
    for (const asset of manifest.assets) {
      for (let offset = 0; offset < asset.byteLength;) {
        if (signal.aborted || manifest.expiresAt <= Date.now()) throw new ScreenRecordingFailure(410, "FRAME_GONE");
        const length = Math.min(1024 * 1024, asset.byteLength - offset);
        const chunk = await this.execute("packageMedia", { viewID, assetID: asset.id, offset, length }, principal, signal);
        if (chunk.header.contentType !== "application/octet-stream" || chunk.body.length !== length) throw new ScreenRecordingFailure(503, "INVALID_PROTOCOL");
        offset += chunk.body.length;
        yield chunk.body;
      }
    }
  }
  dispose(): void { this.client.dispose(); this.owners.clear(); }
}
