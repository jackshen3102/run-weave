import type { PublicConfigurationPatch, PublicConfigurationStatus } from "@runweave/shared/configuration";
import { HttpError } from "./http";

export async function requestConfiguration(apiBase: string, token: string, signal: AbortSignal, patch?: PublicConfigurationPatch): Promise<PublicConfigurationStatus> {
  const response = await fetch(`${apiBase.replace(/\/+$/, "")}/api/configuration`, {
    method: patch ? "PATCH" : "GET", redirect: "error", signal,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(patch ? { body: JSON.stringify(patch) } : {}),
  });
  if (!response.ok) {
    const message = response.status === 409 ? "配置已被其他操作修改，请重新加载后再保存。"
      : response.status === 401 ? "请重新登录当前连接。"
      : response.status === 404 ? "当前电脑版本尚不支持统一配置。"
      : "配置操作失败，请检查字段格式及运行状态。";
    throw new HttpError(response.status, message);
  }
  return response.json() as Promise<PublicConfigurationStatus>;
}
