import path from "node:path";
import type { TerminalConversationResponse } from "@runweave/shared/terminal/conversation";
import type { TerminalSessionManager } from "../manager/manager";
import type { TerminalSessionCreationOptions } from "../application/create-session";
import { readTerminalConversation } from "../application/conversation";
import { readOwnedFile, type ReviewRequirements } from "./store";
export type { ReviewRequirements } from "./store";
import { reviewDigest } from "./snapshot";

export async function captureReviewRequirements(
  root: string,
  read: () => Promise<TerminalConversationResponse>,
): Promise<ReviewRequirements> {
  let value: Omit<ReviewRequirements, "digest">;
  try {
    const source = await read();
    if (source.availability !== "available" || source.partial)
      throw new Error("原始用户要求不可读或不完整，仅能评审代码。");
    const messages = source.turns.flatMap((turn) => turn.messages)
      .filter((message) => message.role === "user" &&
        !message.text.includes("[runweave-task-supervision:") &&
        !message.text.startsWith("[runweave-code-review-feedback:") && !message.text.startsWith("<hook_prompt") &&
        !message.text.startsWith("初始化任务终端。只回复 RW_TASK_READY_"))
      .map(({ id, text }) => ({ id, text }));
    if (!messages.length) throw new Error("没有可核对的用户要求，仅能评审代码。");
    if (messages.length > 64 || Buffer.byteLength(JSON.stringify(messages)) > 64_000)
      throw new Error("用户要求超过核验预算，未截断后猜测任务范围。");
    const references = new Map<string, string[]>();
    const omissions: string[] = [];
    for (const message of messages) {
      for (const match of message.text.matchAll(/(?:^|[\s`(])((?:\/[^\s`)]+\/)?docs\/(?:plans|testing)\/[^\s`)#]+\.(?:md|testplan\.ya?ml))/g)) {
        const reference = path.isAbsolute(match[1]!) ? path.relative(root, match[1]!) : path.posix.normalize(match[1]!);
        if (!reference.startsWith("docs/plans/") && !reference.startsWith("docs/testing/")) {
          omissions.push("计划引用超出当前项目，未读取"); continue;
        }
        references.set(reference, [...new Set([...(references.get(reference) ?? []), message.id])]);
      }
    }
    const plans: ReviewRequirements["plans"] = [];
    if (references.size > 5) omissions.push(`计划引用共${references.size}项，仅读取前5项，剩余未核对`);
    for (const [reference, sourceMessageIds] of [...references].slice(0, 5)) {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(await readOwnedFile(root, reference, 24_000));
        plans.push({ path: reference, sourceMessageIds, digest: reviewDigest(text), text });
      } catch { omissions.push(`计划未读取：${reference}，不可读、越界或超过24000字节`); }
    }
    value = { version: 1, availability: "available", reason: "仅冻结用户消息及其直接引用的计划；采纳关系和当前范围需逐项核对。",
      messages, plans, omissions };
  } catch (error) {
    // Do not expose arbitrary reader errors or credentials in the review package.
    value = { version: 1, availability: "unavailable", reason: error instanceof Error &&
      ["原始用户要求", "没有可核对", "用户要求超过"].some((prefix) => error.message.startsWith(prefix))
      ? error.message : "原始要求读取失败，仅能评审代码；未推断业务目标。", messages: [], plans: [], omissions: [] };
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 48_000) {
    value = { version: 1, availability: "unavailable", reason: "需求及计划合计超过48000字节预算，未截断后宣称覆盖。",
      messages: [], plans: [], omissions: [] };
  }
  return { ...value, digest: reviewDigest(value) };
}

export function readReviewRequirements(manager: TerminalSessionManager, options: TerminalSessionCreationOptions,
  terminalId: string, root: string) {
  return captureReviewRequirements(root, () => readTerminalConversation(manager, terminalId, {},
    AbortSignal.timeout(20_000), options.tmuxService));
}
