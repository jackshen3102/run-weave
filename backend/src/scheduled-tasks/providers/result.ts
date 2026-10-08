import { z } from "zod";

const recoveryProperties = {
  action: { type: "string", enum: ["continue", "wait", "needs-input", "stop"] },
  category: {
    type: "string",
    enum: [
      "remaining-work",
      "transient",
      "external-wait",
      "input",
      "permission",
      "unknown",
    ],
  },
  evidence: { type: "string" },
  nextStep: { type: "string" },
  notBefore: { type: ["string", "null"] },
};
export const recoverySchema = z
  .object({
    action: z.enum(["continue", "wait", "needs-input", "stop"]),
    category: z.enum([
      "remaining-work",
      "transient",
      "external-wait",
      "input",
      "permission",
      "unknown",
    ]),
    evidence: z.string().trim().min(1).max(8_000),
    nextStep: z.string().trim().min(1).max(8_000),
    notBefore: z.string().datetime().nullable(),
  })
  .strict();

export const scheduledResultSchema = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["succeeded", "blocked", "failed"] },
    summary: { type: "string" },
    reason: { type: "string" },
    recovery: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: recoveryProperties,
          required: Object.keys(recoveryProperties),
          additionalProperties: false,
        },
      ],
    },
  },
  required: ["outcome", "summary", "reason", "recovery"],
  additionalProperties: false,
};

const resultSchema = z
  .object({
    outcome: z.enum(["succeeded", "blocked", "failed"]),
    summary: z.string().trim().min(1).max(32_000),
    reason: z.string().trim().max(8_000),
    recovery: recoverySchema.nullable().optional(),
  })
  .strict()
  .refine(
    (result) => result.outcome === "succeeded" || result.reason.length > 0,
  );

export function parseScheduledResult(text: string) {
  try {
    return resultSchema.parse(JSON.parse(text));
  } catch {
    throw new Error("provider_result_invalid");
  }
}

export function scheduledPrompt(prompt: string, runId: string): string {
  return `${prompt}\n\n<scheduled_run_context>\n这是后台定时任务，运行 ID：${runId}。没有交互式 Runweave 终端身份，不得借用其他终端的 Runweave 标识或伪造 terminalSessionId；这不限制常规工具使用当前系统账号已有的合法凭证。需要调用 Runweave CLI 时，若 RUNWEAVE_CLI_BIN 已设置，必须使用 "$RUNWEAVE_CLI_BIN"；登录 shell 中 PATH 里的 rw 可能属于其他运行实例。\n请执行任务，并通过指定 JSON schema 返回最终结果。outcome 仅在用户要求的工作和必要验证实际完成时为 succeeded；权限、网络、认证、审批拒绝或缺少必要输入导致不能继续时为 blocked；执行失败为 failed。summary 用中文 Markdown 说明实际成果和证据，reason 说明阻塞或失败的具体原因与下一步（成功时为空）。进程正常退出、读完技能或生成计划均不等于任务成功。未完成时必须提供 recovery 建议：原授权内仍有具体下一步用 continue/remaining-work；有证据的临时服务故障用 wait/transient；等待 CI 或可验证的外部条件用 wait/external-wait；缺少用户输入用 needs-input/input，权限或审批拒绝用 needs-input/permission；未知结果或不可恢复用 stop/unknown。evidence 写事实依据，nextStep 写核对条件及剩余工作，notBefore 仅在有明确最早恢复时间时写 UTC ISO 时间，否则为 null。成功时 recovery 为 null。继续建议不代表扩展授权，范围不明或并发写入归属不明不能只靠等待自动解决。网络或认证检查超时不等于凭证失效或权限拒绝；先按所用技能区分网络连通、凭证读取与实际认证结果，并在获准路线内有界恢复，原因必须有证据。不要绕过权限限制；审批或权限拒绝后如无获准的替代路径，应返回 blocked。\n</scheduled_run_context>`;
}
