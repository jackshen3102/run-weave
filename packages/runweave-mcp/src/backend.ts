import { resolveAuthContext, type AuthContext } from "@runweave/cli/client";

export class Backend {
  private auth?: Promise<AuthContext>;
  constructor(private profile?: string) {}
  async get<T = unknown>(
    route: string,
    query: Record<string, unknown> = {},
  ): Promise<T> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    this.auth ??= resolveAuthContext({
      profileName: this.profile,
      env: process.env,
    }).catch((error) => {
      this.auth = undefined;
      throw error;
    });
    const auth = await this.auth;
    return auth.requestJson<T>(`${route}${params.size ? `?${params}` : ""}`, {
      signal: AbortSignal.timeout(15_000),
    });
  }
}
