import { z } from "zod";

export const scheduledResultSchema = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["succeeded", "blocked", "failed"] },
    summary: { type: "string" },
    reason: { type: "string" },
  },
  required: ["outcome", "summary", "reason"],
  additionalProperties: false,
};

const resultSchema = z
  .object({
    outcome: z.enum(["succeeded", "blocked", "failed"]),
    summary: z.string().trim().min(1).max(32_000),
    reason: z.string().trim().max(8_000),
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
  return `${prompt}\n\n<scheduled_run_context>\n这是后台定时任务，运行 ID：${runId}。没有交互式终端身份，不得借用其他终端的身份或伪造 terminalSessionId。\n请执行任务，并通过指定 JSON schema 返回最终结果。outcome 仅在用户要求的工作和必要验证实际完成时为 succeeded；权限、网络、认证、审批拒绝或缺少必要输入导致不能继续时为 blocked；执行失败为 failed。summary 用中文 Markdown 说明实际成果和证据，reason 说明阻塞或失败的具体原因与下一步（成功时为空）。进程正常退出、读完技能或生成计划均不等于任务成功。不要绕过权限限制；自动审批拒绝后如无获准的替代路径，应返回 blocked。\n</scheduled_run_context>`;
}
