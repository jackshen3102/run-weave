import type { TunnelState } from "@runweave/shared/tunnels";

export const childState = (
  state: TunnelState["state"],
  error: TunnelState["error"] = null,
): TunnelState => ({ state, error });

export function failure(error: unknown): NonNullable<TunnelState["error"]> {
  const text = error instanceof Error ? error.message : "TUNNEL_FAILED";
  const code = /^[A-Z_]+/.exec(text)?.[0] ?? "TUNNEL_FAILED";
  return {
    code,
    message: text.includes(": ")
      ? text.slice(text.indexOf(": ") + 2)
      : "通道不可用，请检查 SSH 配置和远端服务",
  };
}

export function browserRefreshFailure(error: unknown, connected: boolean, attempt: number) {
  const detail = failure(error);
  const transient = ["BACKEND_UNAVAILABLE", "AUTH_UNAVAILABLE"].includes(detail.code) ||
    (error instanceof Error && ["TypeError", "AbortError", "TimeoutError"].includes(error.name));
  const preserve = transient && connected;
  return {
    preserve,
    retryAt: Date.now() + [1000, 2000, 5000, 10000, 20000][Math.min(attempt, 4)]!,
    browser: childState(preserve ? "reconnecting" : detail.code === "NEEDS_AUTH" ? "needs_auth" : "failed", detail),
  };
}
