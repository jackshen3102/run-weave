import { net } from "electron";
import { usesInstalledServer } from "../desktop/config.js";
import { localBackendAuthHeaders } from "./health-auth.js";
import { resolvePackagedBackendProfileDir } from "./packaged/auth.js";
import { desktopRuntime } from "../desktop/runtime-state.js";

/** Publish this desktop's local Browser endpoint without restarting the Server. */
export async function publishExternalBackendCdpEndpoint(
  endpoint: string,
  backendUrl = process.env.RUNWEAVE_BACKEND_URL ??
    process.env.BROWSER_VIEWER_BACKEND_URL,
): Promise<void> {
  if (!backendUrl) return;
  try {
    const response = await net.fetch(`${backendUrl}/internal/cdp-endpoint`, {
      method: "PUT",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json",
        ...(usesInstalledServer
          ? localBackendAuthHeaders(
              `${backendUrl}/health`,
              resolvePackagedBackendProfileDir(),
            )
          : {}),
      },
      body: JSON.stringify({ endpoint }),
    });
    if (response.ok) {
      desktopRuntime.incidentLogger?.info("externalBackend.cdp.published", {
        backendUrl,
        endpoint,
      });
    } else
      console.warn("[electron] failed to propagate CDP endpoint to backend", {
        status: response.status,
      });
  } catch (error) {
    console.warn("[electron] failed to propagate CDP endpoint to backend", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
