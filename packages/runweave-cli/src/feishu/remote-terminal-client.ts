import { FeishuBridgeError } from "@runweave/shared/feishu/bridge";
import type { SendTerminalInputRequest } from "@runweave/shared/terminal/input";
import { HttpError } from "../errors.js";
import type { FeishuTerminalClient } from "./bridge-message-handler.js";
import type { FeishuHubServer } from "./hub-server.js";
export class RemoteFeishuTerminalClient implements FeishuTerminalClient {
  constructor(
    private readonly hub: FeishuHubServer,
    private readonly backendId: string,
    private readonly expiresAt: number,
    private readonly signal = AbortSignal.timeout(15_000),
  ) {}
  withSignal(signal: AbortSignal): RemoteFeishuTerminalClient {
    return new RemoteFeishuTerminalClient(
      this.hub,
      this.backendId,
      this.expiresAt,
      signal,
    );
  }
  async getSession(terminalSessionId: string): Promise<unknown> {
    try {
      const result = await this.hub.request(
        this.backendId,
        { type: "terminal.get", terminalSessionId },
        this.signal,
      );
      if (!("status" in result)) throw new FeishuBridgeError("invalid_request");
      if (result.status !== "running")
        throw new HttpError(409, "Terminal not running");
      return result;
    } catch (error) {
      throw mapError(error);
    }
  }
  async sendInput(terminalSessionId: string, input: SendTerminalInputRequest) {
    try {
      const result = await this.hub.request(
        this.backendId,
        {
          type: "terminal.input",
          terminalSessionId,
          messageId: input.operationId!.slice("feishu:".length),
          text: input.data,
          expiresAt: this.expiresAt,
        },
        this.signal,
      );
      if (!("inputAccepted" in result))
        throw new FeishuBridgeError("input_unknown");
      return result;
    } catch (error) {
      throw mapError(error);
    }
  }
}
function mapError(error: unknown): unknown {
  if (!(error instanceof FeishuBridgeError)) return error;
  if (error.code === "expired") return new Error("delivery_expired");
  const codes = {
    invalid_request: 400,
    not_found: 404,
    not_running: 409,
    unavailable: 503,
    busy: 429,
    expired: 409,
    input_unknown: 500,
  };
  return new HttpError(
    codes[error.code],
    error.code === "not_running" ? "Terminal not running" : error.code,
  );
}
