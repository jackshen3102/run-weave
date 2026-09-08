import type { CreateMobileLoginRequest, MobileLoginDecision, MobileLoginQrV1, MobileLoginStatus } from "@runweave/shared/mobile-login";

export class MobileLoginHttpError extends Error {
  constructor(readonly status: number, readonly retryAfter: number) {
    super(status === 404 ? "电脑端暂不支持扫码登录，或请求已失效。" :
      status === 410 ? "二维码已失效，请重新生成。" :
      status === 401 ? "当前登录已失效，请重新登录。" :
      status === 429 ? "请求较多，请稍后重试。" : "连接请求未完成，请重试。");
  }
}

async function request<T>(apiBase: string, token: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBase.replace(/\/+$/, "")}/api/auth/mobile-login${path}`, {
    method: body === undefined ? "GET" : "POST", redirect: "error", cache: "no-store", credentials: "omit",
    keepalive: path.endsWith("/cancel"),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new MobileLoginHttpError(response.status, Number(response.headers.get("Retry-After")) || 1);
  return response.json() as Promise<T>;
}

export const createMobileLogin = (base: string, token: string, input: CreateMobileLoginRequest) =>
  request<MobileLoginQrV1>(base, token, "", input);
export const getMobileLogin = (base: string, token: string, id: string) =>
  request<MobileLoginStatus>(base, token, `/${encodeURIComponent(id)}`);
export const decideMobileLogin = (base: string, token: string, id: string, input: MobileLoginDecision) =>
  request<MobileLoginStatus>(base, token, `/${encodeURIComponent(id)}/decision`, input);
export const cancelMobileLogin = (base: string, token: string, id: string) =>
  request<MobileLoginStatus>(base, token, `/${encodeURIComponent(id)}/cancel`, {});
