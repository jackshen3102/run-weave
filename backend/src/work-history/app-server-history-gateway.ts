import type {
  AppServerThreadDetailResponse,
  AppServerThreadListResponse,
} from "@runweave/shared/app-server-events";
import { discoverAppServer } from "@runweave/shared/app-server/discovery";
import { AppServerClient } from "../app-server/client";

const DEFAULT_TIMEOUT_MS = 5_000;

export class AppServerHistoryGatewayError extends Error {
  constructor(readonly code: "thread_not_found" | "unavailable") {
    super(code);
    this.name = "AppServerHistoryGatewayError";
  }
}

export class AppServerHistoryGateway {
  constructor(private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {}

  async listThreads(options: {
    projectId?: string;
    terminalSessionId?: string;
    after?: string | null;
    limit?: number;
  } = {}): Promise<AppServerThreadListResponse> {
    const client = await this.createClient();
    const response = await client.listThreads(
      options,
      AbortSignal.timeout(this.timeoutMs),
    );
    if (!response) {
      throw new AppServerHistoryGatewayError("unavailable");
    }
    return response;
  }

  async getThreadDetail(
    threadId: string,
  ): Promise<AppServerThreadDetailResponse> {
    const client = await this.createClient();
    const response = await client.getThreadDetail(
      threadId,
      AbortSignal.timeout(this.timeoutMs),
    );
    if (response === "thread_not_found") {
      throw new AppServerHistoryGatewayError("thread_not_found");
    }
    if (!response) {
      throw new AppServerHistoryGatewayError("unavailable");
    }
    return response;
  }

  private async createClient(): Promise<AppServerClient> {
    const connection = await discoverAppServer({ env: process.env });
    if (!connection) {
      throw new AppServerHistoryGatewayError("unavailable");
    }
    return new AppServerClient(connection);
  }
}
