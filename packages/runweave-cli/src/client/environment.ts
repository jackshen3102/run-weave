import { ConfigurationError, resolveConfigurationContext, settingText } from "@runweave/config-node";
import type { BackendHealthPayload } from "@runweave/shared/runtime-monitor";

// Verify the instance before transmitting login/refresh credentials or a mutation.
export async function verifyBackendEnvironment(baseUrl: string): Promise<void> {
  const expected = resolveConfigurationContext({ requireExplicit: true });
  const url = new URL(baseUrl);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  const tunnelToken = settingText("backend.tunnelAuth.token");
  const response = await fetch(`${baseUrl}/health`, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    headers: local && tunnelToken ? { Authorization: `Bearer ${tunnelToken}` } : {},
  });
  if (!response.ok) throw new ConfigurationError("CONFIG_TARGET_UNVERIFIED");
  const health = await response.json() as BackendHealthPayload;
  const actual = health.environment;
  if (!actual || actual.kind !== expected.kind || actual.instanceId !== expected.instanceId || local && actual.configRoot !== expected.configRoot) throw new ConfigurationError("CONFIG_TARGET_MISMATCH");
}
