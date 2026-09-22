import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  PushNotificationRequest,
  PushDeliveryResult,
} from "@runweave/shared/push-notifications";
import type { DeviceSubscription } from "./types";
export class PushClientError extends Error {
  constructor(readonly status: number) {
    super(`Push gateway unavailable (${status})`);
  }
}
export class PushClient {
  private verifiedHost = false;
  private controller = new AbortController();
  constructor(
    readonly url: string,
    private credential: string,
    private hostId: string,
  ) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/"
    ) {
      throw new Error("Push gateway requires an HTTPS origin");
    }
    this.url = parsed.origin;
  }
  static async configured(hostId: string, profileDirectory: string): Promise<PushClient | null> {
    const url = process.env.RUNWEAVE_PUSH_GATEWAY_URL;
    const token = process.env.RUNWEAVE_PUSH_SENDER_TOKEN;
    // Explicit overrides are a pair; never combine credentials from different sources.
    if (url !== undefined || token !== undefined) {
      if (!url?.trim() || !token?.trim()) throw new Error("Incomplete push configuration");
      return new PushClient(url.trim(), token.trim(), hostId);
    }
    let raw: string;
    try {
      raw = await readFile(path.join(profileDirectory, "device-monitor", "push.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const config = z.object({
      hostId: z.string().uuid(),
      gatewayURL: z.string().trim().min(1),
      senderToken: z.string().trim().min(1),
    }).strict().parse(JSON.parse(raw));
    if (config.hostId !== hostId) throw new Error("Push configuration belongs to another host");
    return new PushClient(config.gatewayURL, config.senderToken, hostId);
  }
  private async request<T>(
    path: string,
    method: string,
    body?: unknown,
    canSend?: () => boolean,
  ): Promise<T> {
    if (path !== "/v1/sender" && !this.verifiedHost) {
      const identity = await this.request<{ hostId: string }>(
        "/v1/sender",
        "GET",
      );
      if (identity.hostId !== this.hostId) throw new PushClientError(403);
      this.verifiedHost = true;
    }
    if (canSend && !canSend()) throw new PushClientError(409);
    const response = await fetch(`${this.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.credential}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(15_000),
        this.controller.signal,
      ]),
    });
    if (!response.ok) throw new PushClientError(response.status);
    return response.status === 204
      ? (undefined as T)
      : ((await response.json()) as T);
  }
  dispose(): void {
    this.controller.abort();
  }
  register(value: DeviceSubscription): Promise<{ revokeToken: string }> {
    return this.request(`/v1/subscriptions/${value.id}`, "PUT", {
      installationId: value.installationId,
      environment: value.environment,
      deviceToken: value.deviceToken,
      displayName: value.displayName,
      version: value.version,
      categories: ["battery.low"],
    });
  }
  async revoke(id: string): Promise<void> {
    try {
      await this.request(`/v1/subscriptions/${id}`, "DELETE");
    } catch (error) {
      if (!(error instanceof PushClientError) || error.status !== 404)
        throw error;
    }
  }
  async send(
    notification: PushNotificationRequest,
    canSend?: () => boolean,
  ): Promise<PushDeliveryResult> {
    try {
      return await this.request(
        "/v1/notifications",
        "POST",
        notification,
        canSend,
      );
    } catch (error) {
      if (
        error instanceof PushClientError &&
        (error.status === 429 || error.status >= 500)
      )
        return { state: "retry" };
      if (error instanceof PushClientError) throw error;
      return { state: "unknown" }; // The relay may already have submitted this request.
    }
  }
}
