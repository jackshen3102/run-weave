import { settingText } from "@runweave/config-node";
import { CliError } from "../errors.js";

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  targetChatId: string | null;
  allowedOpenIds: Set<string>;
  notifyOpenIds: Set<string>;
}

export function resolveFeishuConfig(
  env: NodeJS.ProcessEnv,
  options: { requireTargetChatId?: boolean } = {},
): FeishuConfig {
  const appId = settingText("services.feishu.appId")?.trim();
  const appSecret = settingText("services.feishu.appSecret")?.trim();
  const targetChatId = settingText("services.feishu.targetChatId")?.trim();
  if (!appId || !appSecret || (options.requireTargetChatId && !targetChatId)) {
    throw new CliError(
      options.requireTargetChatId
        ? "FEISHU_APP_ID, FEISHU_APP_SECRET and FEISHU_TARGET_CHAT_ID are required"
        : "FEISHU_APP_ID and FEISHU_APP_SECRET are required",
      2,
    );
  }
  const allowedOpenIds = new Set(
    (settingText("services.feishu.allowedOpenIds") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const notifyOpenIds = new Set(
    (settingText("services.feishu.notifyOpenIds") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  for (const openId of notifyOpenIds) {
    if (!/^ou_[a-zA-Z0-9]+$/.test(openId)) {
      throw new CliError(
        "FEISHU_NOTIFY_OPEN_IDS must contain user open IDs",
        2,
      );
    }
  }
  return {
    appId,
    appSecret,
    targetChatId: targetChatId ?? null,
    allowedOpenIds,
    notifyOpenIds,
  };
}
