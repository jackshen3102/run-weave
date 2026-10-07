import { setting } from "@runweave/config-node";
import type {
  SupervisionTarget,
  SupervisionDiscovery,
  SupervisionHookRequest,
} from "@runweave/shared/task-supervision";
import { probeExecutorConfig } from "./probe";
import { SupervisionError } from "./errors";
export async function checkSupervisionConflicts(
  target: SupervisionTarget,
  root: string,
  context?: SupervisionHookRequest["executionConfig"],
) {
  if (!context)
    throw new SupervisionError(
      "无法核对原执行器配置，请从标准终端 Agent 入口重新启动。",
      422,
    );
  void root;
  const inspected = await probeExecutorConfig(context, target.threadId);
  const goal = inspected.goal as { goal?: { status: string } | null };
  if (
    goal.goal &&
    !["complete", "blocked", "budgetLimited", "usageLimited"].includes(
      goal.goal.status,
    )
  )
    throw new SupervisionError(
      "当前任务存在 Codex Goal，请先明确选择单一续接来源。",
      422,
    );
  const listed = inspected.hooks as {
    data: Array<{
      errors: unknown[];
      hooks: Array<{
        eventName: string;
        enabled: boolean;
        command?: string;
        timeoutSec: number;
        trustStatus: string;
      }>;
    }>;
  };
  const entry = listed.data[0];
  if (!entry || entry.errors.length)
    throw new SupervisionError("无法核对当前任务的 Hook 配置。", 422);
  const stops = entry.hooks.filter((h) => h.enabled && h.eventName === "stop");
  const stop = stops[0];
  if (
    stops.length !== 1 ||
    !stop ||
    !stop.command?.includes("runweave-hook-dispatch.cjs") ||
    Number(stop.timeoutSec) < 120 ||
    (!inspected.bypassTrust &&
      !["trusted", "managed"].includes(stop.trustStatus))
  )
    throw new SupervisionError(
      "Stop Hook 未受信任、等待时间不足或存在其他续接 Hook；请在 Codex /hooks 核对。",
      422,
    );
  if (
    !entry.hooks.some(
      (h) =>
        h.enabled &&
        h.eventName === "interrupt" &&
        h.command?.includes("runweave-hook-dispatch.cjs") &&
        (inspected.bypassTrust ||
          ["trusted", "managed"].includes(h.trustStatus)),
    )
  )
    throw new SupervisionError("缺少已受信任的中断 Hook。", 422);
}

export function supervisionCapability(
  target: SupervisionTarget,
  cap?: Pick<
    SupervisionHookRequest,
    "target" | "codexVersion" | "hookVersion" | "executionConfig"
  >,
): SupervisionDiscovery["capability"] {
  if (!setting<boolean>("backend.taskSupervision.enabled", false))
    return {
      supported: false,
      reason: "请在本实例配置中开启 backend.taskSupervision.enabled。",
    };
  if (!cap || JSON.stringify(cap.target) !== JSON.stringify(target))
    return {
      supported: false,
      reason:
        "当前执行器尚未加载新版监督 Hook。更新 Toolkit 并在原终端重新启动 Codex 后再开启。",
    };
  if (cap.codexVersion !== "codex-cli 0.160.0")
    return {
      codexVersion: cap.codexVersion,
      hookVersion: cap.hookVersion,
      supported: false,
      reason: "当前 Codex 版本尚未通过原终端续接兼容验证。",
    };
  return {
    supported: true,
    codexVersion: cap.codexVersion,
    hookVersion: cap.hookVersion,
  };
}
