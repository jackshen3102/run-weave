export const inputClass =
  "mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm";
export function browserBindingErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("BROWSER_BINDING_CONFLICT"))
    return "此终端正在使用另一台桌面的浏览器。请先在原桌面断开浏览器通道，再重新选择。";
  if (message.includes("NEEDS_AUTH"))
    return "远端登录已过期，请在「端口与隧道」中重新登录浏览器通道。";
  if (message.includes("DESKTOP_UNAVAILABLE") || message.includes("TUNNEL_CANCELLED"))
    return "浏览器通道尚未就绪，请在「端口与隧道」中检查连接后重试。";
  return "无法连接此终端的浏览器通道，请在「端口与隧道」中检查连接后重试。";
}
export function remoteDesktopErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
    .replace(/^REMOTE_DESKTOP_[A-Z_]+:\s*/, "");
}
export const labels: Record<string, string> = {
  disconnected: "未连接",
  connecting: "连接中",
  ready: "已建立",
  reconnecting: "正在重连",
  failed: "运行失败",
  disabled: "已关闭",
  waiting: "等待主机连接",
  starting: "启动中",
  needs_auth: "需要登录",
};
