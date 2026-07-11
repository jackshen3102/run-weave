import { CliError } from "../errors.js";

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  targetChatId: string | null;
  allowedOpenIds: Set<string>;
  bindingTtlMs: number;
}

export function resolveFeishuConfig(
  env: NodeJS.ProcessEnv,
  options: { requireTargetChatId?: boolean } = {},
): FeishuConfig {
  const appId = env.FEISHU_APP_ID?.trim();
  const appSecret = env.FEISHU_APP_SECRET?.trim();
  const targetChatId = env.FEISHU_TARGET_CHAT_ID?.trim();
  if (!appId || !appSecret || (options.requireTargetChatId && !targetChatId)) {
    throw new CliError(
      options.requireTargetChatId
        ? "FEISHU_APP_ID, FEISHU_APP_SECRET and FEISHU_TARGET_CHAT_ID are required"
        : "FEISHU_APP_ID and FEISHU_APP_SECRET are required",
      2,
    );
  }
  const allowedOpenIds = new Set(
    (env.FEISHU_ALLOWED_OPEN_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const ttlHours = Number(env.FEISHU_BINDING_TTL_HOURS ?? "24");
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
    throw new CliError("FEISHU_BINDING_TTL_HOURS must be a positive number", 2);
  }
  return {
    appId,
    appSecret,
    targetChatId: targetChatId ?? null,
    allowedOpenIds,
    bindingTtlMs: ttlHours * 60 * 60 * 1000,
  };
}
