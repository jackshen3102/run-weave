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
    const latencyMs = Math.round(performance.now() - startedAt);
    return {
      ok: true,
      latencyMs,
      payload,
      failure: null,
    };
  } catch (error) {
    const failure = classifyApiFailure(error);
    const latencyMs = Math.round(performance.now() - startedAt);
    return {
      ok: false,
      latencyMs,
      payload: null,
      failure,
    };
  } finally {
    window.clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}
