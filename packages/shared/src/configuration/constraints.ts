/** Shared validation metadata used by the validator and generated reference. */
export const CONFIGURATION_ENUMS: Readonly<Record<string, readonly string[]>> = {
  "backend.tunnelAuth.scope": ["all", "forwarded"],
  "appServer.discovery": ["auto", "explicit", "disabled"],
  "logging.level": ["error", "warn", "info", "http", "verbose", "debug", "silly"],
  "terminal.tmux.shutdownPolicy": ["preserve", "cleanup"],
  "services.suiji.ai.provider": ["disabled", "codex-cli"],
  "services.feishu.legacyWebhook.transport": ["app", "webhook"],
};
export const CONFIGURATION_CREDENTIAL_GROUPS: Readonly<Record<string, readonly string[]>> = {
  "backend.auth": ["username", "password", "jwtSecret"],
  "services.snapshotPublisher": ["url", "token"],
  "services.pushSender": ["gatewayURL", "senderToken", "hostId"],
  "services.feishu": ["appId", "appSecret"],
};
export function configurationNumberRange(key: string): { min?: number; max?: number; exclusiveMin?: number } {
  if (/port$/i.test(key)) return { min: 1, max: 65535 };
  if (/(?:TtlSeconds|timeoutMs|maxOutputBytes|maxConcurrentRuns|Seconds|IntervalMs)$/.test(key)) return { exclusiveMin: 0 };
  if (/DelayMs$/.test(key)) return { min: 0 };
  return {};
}
export function configurationOwnedPath(key: string): boolean {
  return key.startsWith("storage.") || key === "logging.backendDirectory" || ["appServer.stateDirectory", "appServer.cloudSyncDirectory", "services.snapshotHost.directory", "services.pushGateway.directory", "services.suiji.storageDirectory"].includes(key);
}
export function configurationServiceOrigin(key: string): boolean {
  return ["services.snapshotPublisher.url", "services.pushSender.gatewayURL"].includes(key);
}
