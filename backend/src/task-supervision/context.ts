import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  ConversationContent,
  ConversationMessage,
} from "@runweave/shared/terminal/conversation";
import type {
  SupervisionInput,
  SupervisionPlan,
  TaskWatch,
} from "@runweave/shared/task-supervision";

// Conservative bound for the default Codex model. Required material is never truncated.
export const INPUT_BUDGET_BYTES = 180_000;
export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const isSupervisionPrompt = (text: string) =>
  text.includes("[runweave-task-supervision:");
export function messagesFrom(
  content: ConversationContent,
): ConversationMessage[] {
  if (content.availability !== "available" || content.partial)
    throw new Error("原始会话缺失或不完整，请补充任务来源后重试。");
  return content.turns.flatMap((turn) => turn.messages);
}
export function taskCandidates(content: ConversationContent) {
  return messagesFrom(content).filter(
    (m) =>
      m.role === "user" &&
      !isSupervisionPrompt(m.text) &&
      !m.text.startsWith("<hook_prompt"),
  );
}
export function referencedPlans(messages: ConversationMessage[]): string[] {
  return [
    ...new Set(
      messages.flatMap((message) =>
        [
          ...message.text.matchAll(
            /(?:^|[\s`(])((?:docs\/plans\/|docs\/testing\/)[^\s`)#]+\.(?:md|testplan\.ya?ml))/g,
          ),
        ].map((match) => match[1]!),
      ),
    ),
  ];
}
export async function readPlans(
  root: string,
  references: string[],
): Promise<SupervisionPlan[]> {
  if (references.length > 10)
    throw new Error("计划引用超过 10 个，请明确任务范围。");
  const realRoot = await realpath(root);
  return Promise.all(
    references.map(async (reference) => {
      if (!/\.(?:md|testplan\.ya?ml)$/.test(reference))
        throw new Error("仅支持 Markdown 计划或 testplan.yaml 测试用例引用。");
      if (path.isAbsolute(reference))
        throw new Error("计划引用必须是当前项目内的相对路径。");
      const file = await realpath(path.resolve(realRoot, reference));
      if (!file.startsWith(`${realRoot}${path.sep}`))
        throw new Error("计划引用不能跨项目。");
      const info = await stat(file);
      if (!info.isFile() || info.size > INPUT_BUDGET_BYTES)
        throw new Error("计划过大或不可读，请明确任务范围。");
      const text = await readFile(file, "utf8");
      return {
        path: path.relative(realRoot, file),
        digest: digest(text),
        text,
      };
    }),
  );
}
export async function refreshReferencedPlans(
  root: string,
  watch: TaskWatch,
  messages: ConversationMessage[],
) {
  const following = messages.slice(
    messages.findIndex((m) => m.id === watch.taskStartMessageId),
  );
  watch.plans = await readPlans(root, [
    ...new Set([
      ...watch.plans.map((p) => p.path),
      ...referencedPlans(following),
    ]),
  ]);
}
export function buildSupervisionInput(
  watch: TaskWatch,
  content: ConversationContent,
  reply: SupervisionInput["currentReply"],
): SupervisionInput {
  const messages = messagesFrom(content);
  const start = messages.findIndex(
    (m) => m.id === watch.taskStartMessageId && m.role === "user",
  );
  if (start < 0) throw new Error("找不到原始任务起点，请重新核对任务来源。");
  const following = messages.slice(start + 1);
  const updates = following.filter(
    (m) =>
      m.role === "user" &&
      !isSupervisionPrompt(m.text) &&
      !m.text.startsWith("<hook_prompt"),
  );
  let recent = following
    .filter(
      (m) => m.id !== reply.id && (m.role === "user" || m.phase === "final"),
    )
    .slice(-4);
  const input: SupervisionInput = {
    task: watch.task,
    goal: watch.goal,
    plan: watch.plans,
    userUpdates: updates,
    recentExchanges: recent,
    currentReply: reply,
  };
  const size = () => Buffer.byteLength(JSON.stringify(input));
  while (size() > INPUT_BUDGET_BYTES && recent.length) {
    recent = recent.slice(1);
    input.recentExchanges = recent;
  }
  if (size() > INPUT_BUDGET_BYTES)
    throw new Error(
      "上下文超出输入预算；原目标、计划和完整回答已保留，等待你补充范围。",
    );
  return input;
}
