import type {
  SuijiErrorResponse,
  SuijiInfo,
  SuijiTokens,
} from "@runweave/shared/suiji";

type SavedSession = { tokens: SuijiTokens; expiresAt: number };
export class SuijiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: SuijiErrorResponse,
  ) {
    super(detail.error.message);
  }
  get uncertain() {
    return (
      ![400, 404, 409, 413].includes(this.status) ||
      this.detail.error.code === "IDEMPOTENCY_KEY_REUSED"
    );
  }
}
export function suijiEndpoint(value: string) {
  const url = new URL(value.trim());
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("请输入完整的随记服务地址");
  if (
    url.protocol === "http:" &&
    !import.meta.env.DEV &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error("远程随记服务需要 HTTPS");
  return url.href.replace(/\/+$/, "");
}
export class SuijiClient {
  readonly endpoint: string;
  private saved?: SavedSession;
  private lifetime = new AbortController();
  private renewing?: Promise<SavedSession>;
  constructor(endpoint: string) {
    this.endpoint = suijiEndpoint(endpoint);
    try {
      this.saved =
        JSON.parse(sessionStorage.getItem(this.storageKey) ?? "null") ??
        undefined;
    } catch {
      /* Missing or invalid session. */
    }
  }
  get active() {
    return !this.lifetime.signal.aborted;
  }
  private get storageKey() {
    return `suiji.session.v1:${this.endpoint}`;
  }
  private assertActive() {
    if (!this.active) throw new DOMException("服务连接已切换", "AbortError");
  }
  cancel() {
    this.lifetime.abort();
  }
  private store(tokens: SuijiTokens) {
    this.assertActive();
    const saved = { tokens, expiresAt: Date.now() + tokens.expiresIn * 1000 };
    sessionStorage.setItem(this.storageKey, JSON.stringify(saved));
    this.saved = saved;
    return saved;
  }
  private async raw(
    path: string,
    method: string,
    body?: BodyInit,
    token?: string,
    key?: string,
    signal?: AbortSignal,
  ) {
    this.assertActive();
    const response = await fetch(this.endpoint + path, {
      method,
      body,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.any([
        this.lifetime.signal,
        AbortSignal.timeout(30_000),
        ...(signal ? [signal] : []),
      ]),
      headers: {
        ...(body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
    });
    this.assertActive();
    if (!response.ok) {
      const error = (await response.json()) as SuijiErrorResponse;
      if (error?.error?.message)
        throw new SuijiHttpError(response.status, error);
      throw new Error(`服务响应异常（${response.status}），请手动确认结果`);
    }
    return response;
  }
  async login(username: string, password: string) {
    const response = await this.raw(
      "/api/auth/login",
      "POST",
      JSON.stringify({ username, password }),
    );
    this.store((await response.json()) as SuijiTokens);
    return this.info();
  }
  private refresh() {
    if (this.renewing) return this.renewing;
    const old = this.saved;
    if (!old) return Promise.reject(new Error("请登录随记"));
    this.renewing = (async () => {
      const response = await this.raw(
        "/api/auth/refresh",
        "POST",
        JSON.stringify({ refreshToken: old.tokens.refreshToken }),
      );
      const tokens = (await response.json()) as SuijiTokens;
      if (
        tokens.ownerId !== old.tokens.ownerId ||
        tokens.serverId !== old.tokens.serverId
      )
        throw new Error("服务身份已改变，请重新登录；原草稿仍保留");
      return this.store(tokens);
    })().finally(() => {
      this.renewing = undefined;
    });
    return this.renewing;
  }
  private async authorized(
    path: string,
    method: string,
    body?: BodyInit,
    key?: string,
    signal?: AbortSignal,
  ) {
    let saved = this.saved;
    if (!saved) throw new Error("请登录随记");
    if (saved.expiresAt < Date.now() + 60_000) saved = await this.refresh();
    try {
      return await this.raw(
        path,
        method,
        body,
        saved.tokens.accessToken,
        key,
        signal,
      );
    } catch (error) {
      if (
        !(
          error instanceof SuijiHttpError &&
          error.status === 401 &&
          method === "GET"
        )
      )
        throw error;
      const renewed = await this.refresh();
      return this.raw(
        path,
        method,
        body,
        renewed.tokens.accessToken,
        key,
        signal,
      );
    }
  }
  async request<T>(
    path: string,
    method = "GET",
    data?: unknown,
    key?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.authorized(
      path,
      method,
      data instanceof FormData
        ? data
        : data === undefined
          ? undefined
          : JSON.stringify(data),
      key,
      signal,
    );
    const result = (await response.json()) as T;
    this.assertActive();
    return result;
  }
  async file(id: string) {
    const response = await this.authorized(
      `/api/suiji/v1/attachments/${encodeURIComponent(id)}/content`,
      "GET",
    );
    const blob = await response.blob();
    this.assertActive();
    return blob;
  }
  async info() {
    const value = await this.request<SuijiInfo>("/api/suiji/v1/info");
    if (
      value.protocolVersion !== 1 ||
      value.ownerId !== this.saved?.tokens.ownerId ||
      value.serverId !== this.saved?.tokens.serverId
    )
      throw new Error("服务身份或协议已改变，请重新登录；原草稿仍保留");
    return value;
  }
  async logout() {
    const saved = this.saved;
    this.cancel();
    this.saved = undefined;
    sessionStorage.removeItem(this.storageKey);
    if (saved) {
      try {
        await fetch(this.endpoint + "/api/auth/logout", {
          method: "POST",
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(5000),
          headers: { Authorization: `Bearer ${saved.tokens.accessToken}` },
        });
      } catch {
        /* Local logout is complete; remote token expires normally. */
      }
    }
  }
}
