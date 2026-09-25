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
