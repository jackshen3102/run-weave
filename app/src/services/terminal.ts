import type { TerminalMobileOverviewResponse } from "@browser-viewer/shared";

import { requestJson } from "./http";

export async function getTerminalMobileOverview(
  apiBase: string,
  accessToken: string,
): Promise<TerminalMobileOverviewResponse> {
  return requestJson<TerminalMobileOverviewResponse>(
    apiBase,
    "/api/terminal/mobile/overview?includeTail=false",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
}
