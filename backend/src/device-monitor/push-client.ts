import { readConfigurationPath } from "@runweave/shared/configuration";
import { settingText, configuration, type ConfigurationSnapshot } from "@runweave/config-node";
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
  private pendingRequests = 0;
  private retired = false;
  private onDrained?: () => void;
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
  static async configured(
    hostId: string,
    snapshot?: ConfigurationSnapshot,
  ): Promise<PushClient | null> {
    if (!snapshot) configuration().requireDomain("services.pushSender");
    const get = (key: string) => snapshot ? readConfigurationPath(snapshot.value, `services.pushSender.${key}`) : settingText(`services.pushSender.${key}`);
    const url = get("gatewayURL");
    const token = get("senderToken");
    const configuredHost = get("hostId");
    // Explicit overrides are a pair; never combine credentials from different sources.
    if (url != null || token != null) {
      if (typeof url !== "string" || typeof token !== "string" || !url.trim() || !token.trim() || configuredHost !== hostId)
        throw new Error("Incomplete push configuration");
      return new PushClient(url.trim(), token.trim(), hostId);
    }
    return null;
  }

  private async request<T>(
    path: string,
    method: string,
    body?: unknown,
    canSend?: () => boolean,
  ): Promise<T> {
    this.pendingRequests += 1;
    try { return await this.performRequest<T>(path, method, body, canSend); }
    finally {
      this.pendingRequests -= 1;
      if (this.retired && this.pendingRequests === 0) this.finishRetirement();
    }
  }
  private async performRequest<T>(path: string, method: string, body?: unknown, canSend?: () => boolean): Promise<T> {
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
  retire(): Promise<void> {
    this.retired = true;
    if (!this.pendingRequests) { this.finishRetirement(); return Promise.resolve(); }
    return new Promise((resolve) => { this.onDrained = resolve; });
  }
  private finishRetirement(): void {
    this.controller.abort();
    this.credential = "";
    this.onDrained?.();
    this.onDrained = undefined;
  }
  dispose(): void { this.controller.abort(); }
  register(value: DeviceSubscription): Promise<{ revokeToken: string }> {
    return this.request(`/v1/subscriptions/${value.id}`, "PUT", {
      installationId: value.installationId,
      environment: value.environment,
      deviceToken: value.deviceToken,
      displayName: value.displayName,
      version: value.version,
      categories:
        value.kind === "scheduled-task"
          ? ["task.completed", "task.failed"]
          : ["battery.low"],
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
