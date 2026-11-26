/* global AbortSignal, fetch, module, URL */

function deriveHookDiagnosticsEndpoint(endpoint) {
  if (!endpoint) return undefined;
  try {
    const url = new URL(endpoint);
    url.pathname = "/internal/terminal/hook-diagnostics";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

async function postHookDiagnostic({ endpoint, token, body }) {
  if (!endpoint || !token) return { ok: false, reason: "unavailable" };
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Runweave-Hook-Token": token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1_000),
    });
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, reason: "request_failed" };
  }
}

module.exports = { deriveHookDiagnosticsEndpoint, postHookDiagnostic };
