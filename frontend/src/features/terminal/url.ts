export function toWebSocketBase(apiBase: string): string {
  const resolvedBase = apiBase.trim();
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
