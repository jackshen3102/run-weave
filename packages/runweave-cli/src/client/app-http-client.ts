import type { AppHomeOverviewResponse } from "@runweave/shared";
import { requestJson } from "./http.js";

export class AppHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly accessToken?: string,
  ) {}

  getOverview(): Promise<AppHomeOverviewResponse> {
    return requestJson<AppHomeOverviewResponse>(
      this.baseUrl,
      "/api/app/home/overview",
      this.accessToken
        ? {
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
            },
          }
        : undefined,
    );
  }
}
