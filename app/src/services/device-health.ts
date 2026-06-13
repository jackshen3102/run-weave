import type { BackendHealthPayload } from "@runweave/shared";

import { classifyApiFailure, type AppApiFailure } from "./api-failure";
import { requestJson } from "./http";

export interface BackendHealthResult {
  ok: boolean;
  latencyMs: number;
  payload: BackendHealthPayload | null;
  failure: AppApiFailure | null;
}

export async function getBackendHealth(
  apiBase: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<BackendHealthResult> {
  const timeoutMs = options.timeoutMs ?? 2500;
  const controller = new AbortController();
  const startedAt = performance.now();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  const abortFromCaller = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    const payload = await requestJson<BackendHealthPayload>(
      apiBase,
      "/health",
      { signal: controller.signal },
    );
    return {
      ok: true,
      latencyMs: Math.round(performance.now() - startedAt),
      payload,
      failure: null,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      payload: null,
      failure: classifyApiFailure(error),
    };
  } finally {
    window.clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}
