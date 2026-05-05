export interface HealthPayload {
  status: "ok";
  runtimeReleaseId?: string;
}

export function buildHealthPayload(env: NodeJS.ProcessEnv): HealthPayload {
  const runtimeReleaseId = env.RUNWEAVE_RUNTIME_RELEASE_ID?.trim();
  if (!runtimeReleaseId) {
    return { status: "ok" };
  }

  return {
    status: "ok",
    runtimeReleaseId,
  };
}
