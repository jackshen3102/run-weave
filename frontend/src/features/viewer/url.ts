export function toWebSocketBase(apiBase: string): string {
  if (!apiBase) {
    return window.location.origin.replace(/^http/, "ws");
  }

  if (apiBase.startsWith("https://")) {
    return apiBase.replace("https://", "wss://");
  }
  if (apiBase.startsWith("http://")) {
    return apiBase.replace("http://", "ws://");
  }
  return apiBase;
}

export function buildViewerWsUrl(
  apiBase: string,
  sessionId: string,
  token: string,
): string {
  return `${toWebSocketBase(apiBase)}/ws?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`;
}

export function getTabIdFromSearch(search: string): string | null {
  return new URLSearchParams(search).get("tabId");
}

export function syncUrlTabId(tabId: string | null): void {
  const params = new URLSearchParams(window.location.search);
  const currentTabId = params.get("tabId");

  if (tabId) {
    if (currentTabId === tabId) {
      return;
    }
    params.set("tabId", tabId);
  } else {
    if (!currentTabId) {
      return;
    }
    params.delete("tabId");
  }

  const query = params.toString();
  const next = query
    ? `${window.location.pathname}?${query}`
    : window.location.pathname;
  window.history.replaceState(null, "", next);
}

export function normalizeNavigationUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}
