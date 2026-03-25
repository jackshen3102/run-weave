function resolveApiBase(apiBase: string): string {
  const trimmed = apiBase.trim();
  if (trimmed) {
    return trimmed;
  }

  const proxyTarget = import.meta.env.VITE_PROXY_TARGET;
  if (typeof proxyTarget === "string" && proxyTarget.trim()) {
    return proxyTarget.trim();
  }

  return "";
}

export function toWebSocketBase(apiBase: string): string {
  const resolvedBase = resolveApiBase(apiBase);
  if (!resolvedBase) {
    return window.location.origin.replace(/^http/, "ws");
  }

  if (resolvedBase.startsWith("https://")) {
    return resolvedBase.replace("https://", "wss://");
  }
  if (resolvedBase.startsWith("http://")) {
    return resolvedBase.replace("http://", "ws://");
  }
  return resolvedBase;
}

export function toHttpBase(apiBase: string): string {
  const resolvedBase = resolveApiBase(apiBase);
  if (!resolvedBase) {
    return window.location.origin;
  }

  if (resolvedBase.startsWith("wss://")) {
    return resolvedBase.replace("wss://", "https://");
  }
  if (resolvedBase.startsWith("ws://")) {
    return resolvedBase.replace("ws://", "http://");
  }
  return resolvedBase;
}

export function buildViewerWsUrl(
  apiBase: string,
  sessionId: string,
  token: string,
): string {
  return `${toWebSocketBase(apiBase)}/ws?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`;
}

export function buildDevtoolsPageUrl(
  apiBase: string,
  sessionId: string,
  tabId: string,
): string {
  return `${toHttpBase(apiBase)}/devtools?sessionId=${encodeURIComponent(sessionId)}&tabId=${encodeURIComponent(tabId)}`;
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
