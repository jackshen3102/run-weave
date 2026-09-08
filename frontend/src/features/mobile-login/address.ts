import { normalizeMobileLoginBaseUrl } from "@runweave/shared/mobile-login";
import { LOCAL_DEV_CONNECTION_ID } from "../connection/system-connection";
import type { ConnectionConfig } from "../connection/types";

export async function mobileLoginAddresses(connection: ConnectionConfig): Promise<string[]> {
  if (connection.available === false) throw new Error("电脑后端暂不可用，请恢复连接后重试。");
  if (connection.id !== LOCAL_DEV_CONNECTION_ID || !connection.isSystem) {
    try { return [normalizeMobileLoginBaseUrl(connection.url)]; }
    catch { throw new Error("请配置手机可访问的连接地址；自定义本地转发地址不能用于扫码。"); }
  }
  const report = await window.electronAPI?.getRuntimeStatusReport?.();
  const backend = report?.items.find((item) => item.id === "electron.packaged-backend");
  const backendUrl = backend?.facts.find((fact) => fact.id === "electron.packaged-backend.address")?.value;
  if (!report || report.source.runtime !== "electron" || report.target.kind !== "local-host" ||
    report.observedAt + report.validForMs < Date.now() ||
    typeof backendUrl !== "string" || backendUrl.replace(/\/+$/, "") !== connection.url.replace(/\/+$/, "")) {
    throw new Error("暂时无法取得这台电脑的连接地址，请稍后重试。");
  }
  const network = report.items.find((item) => item.id === "electron.local-network");
  const addresses = network?.state === "healthy" ? network.facts.filter((fact) =>
    fact.id === "electron.local-network.primary" || fact.id.startsWith("electron.local-network.candidate-"))
    .flatMap((fact) => { try { return [normalizeMobileLoginBaseUrl(String(fact.value))]; } catch { return []; } }) : [];
  if (!addresses.length) throw new Error("未找到可分享的局域网地址，请检查网络或使用手动登录。");
  return [...new Set(addresses)];
}
