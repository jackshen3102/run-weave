import { resolveAuthContext, type AuthContext } from "@runweave/cli/client";

export class Backend {
  private auth?: Promise<AuthContext>;
  constructor(private profile?: string) {}
  async get<T = unknown>(
    route: string,
    query: Record<string, unknown> = {},
    timeoutMs = 15_000,
  ): Promise<T> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const auth = await this.resolveAuth();
    return auth.requestJson<T>(`${route}${params.size ? `?${params}` : ""}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
  async post<T>(route: string, body: object, timeoutMs = 15_000): Promise<T> {
    const auth = await this.resolveAuth();
    return auth.requestJson<T>(route, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  }
  private resolveAuth() {
    return this.auth ??= resolveAuthContext({ profileName: this.profile, env: process.env }).catch(error => {
      this.auth = undefined;
      throw error;
    });
  }

}
