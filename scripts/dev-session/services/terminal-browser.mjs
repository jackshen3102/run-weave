import { DevSessionError, assertLoopbackUrl } from "../contracts.mjs";
import { fetchHealthJson } from "./runtime.mjs";

export async function prepareTerminalBrowserEndpoint(endpoint) {
  const baseUrl = new URL(
    assertLoopbackUrl(endpoint, "terminal-browser CDP endpoint"),
  );
  baseUrl.protocol = "http:";
  let response;
  let resolved;
  try {
    response = await fetch(
      new URL("/runweave/browser-profile/resolve", baseUrl),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Use this instance's default Profile, not the Stable control terminal's
        // ambient Project, Group or automation attribution.
        body: JSON.stringify({
          projectId: null,
          explicitProfileId: null,
          browserGroupId: null,
          terminalSessionId: null,
        }),
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
      },
    );
    resolved = await response.json();
  } catch {
    throw new DevSessionError(
      "terminal-browser Profile initialization failed: resolver unavailable or invalid response",
      5,
    );
  }
  if (!response.ok) {
    throw new DevSessionError(
      `terminal-browser Profile initialization failed (HTTP ${response.status})`,
      5,
      { error: resolved?.error },
    );
  }
  const scopedEndpoint = assertLoopbackUrl(
    resolved?.cdpEndpoint,
    "resolved terminal-browser CDP endpoint",
  );
  const scopedUrl = new URL(scopedEndpoint);
  if (scopedUrl.protocol !== "ws:" || scopedUrl.host !== baseUrl.host) {
    throw new DevSessionError(
      "resolved terminal-browser CDP endpoint does not belong to this Session",
      5,
    );
  }
  const targetsUrl = new URL("/json/list", baseUrl);
  targetsUrl.search = scopedUrl.search;
  const targets = await fetchHealthJson(targetsUrl.href);
  if (
    !Array.isArray(targets) ||
    !targets.some((target) => target?.type === "page" && target.id)
  ) {
    throw new DevSessionError(
      "terminal-browser Profile initialized without an available page target",
      5,
    );
  }
  return scopedEndpoint;
}
