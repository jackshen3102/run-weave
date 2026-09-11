import type {
  BatteryNotification,
  PushDeliveryResult,
} from "@runweave/shared/device-notifications";
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
  static configured(hostId: string): PushClient | null {
    const url = process.env.RUNWEAVE_PUSH_GATEWAY_URL;
    const token = process.env.RUNWEAVE_PUSH_SENDER_TOKEN;
    return url && token ? new PushClient(url, token, hostId) : null;
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
  completeCycle(id: string): Promise<void> {
    return this.request(`/v1/cycles/${id}/complete`, "POST");
  }
  async send(
    alert: BatteryNotification,
    canSend?: () => boolean,
  ): Promise<PushDeliveryResult> {
    try {
      return await this.request("/v1/battery-alerts", "POST", alert, canSend);
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
