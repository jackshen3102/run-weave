import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  ConversationContent,
  ConversationMessage,
  SupervisionConversationResponse,
} from "@runweave/shared/terminal/conversation";
import type {
  SupervisionInput,
  SupervisionPlan,
  TaskWatch,
  PreviousSupervisionContinuation,
} from "@runweave/shared/task-supervision";

// Conservative bound for the default Codex model. Required material is never truncated.
export const INPUT_BUDGET_BYTES = 180_000;
export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const isSupervisionPrompt = (text: string) =>
  text.includes("[runweave-task-supervision:");
export async function readWatchContext(
  watch: TaskWatch,
  threadId: string,
  read: (
    threadId: string,
    ids: string[],
  ) => Promise<SupervisionConversationResponse>,
) {
  const current = watch.target.threadId === threadId;
  const ids = current
    ? [
        ...new Set([
          watch.taskStartMessageId,
          ...(watch.evidenceMessageIds ?? []),
          ...(watch.completedReplyIds ?? []),
          ...(watch.goalDefinition?.sourceMessageIds ?? []),
          ...(watch.goalDefinition?.plans.flatMap((p) => [p.sourceMessageId, p.authorizationMessageId]) ?? []),
        ]),
      ].filter((id) => !id.startsWith("pending:") && !id.startsWith("goal-manual:"))
    : [];
  if (ids.length > 63)
    throw new Error(
      "当前会话必要证据引用超过预算；本次未自动继续，监听保持开启。",
    );
  const source = await read(threadId, ids);
  if (
    current &&
    watch.sourceVersion &&
    source.sourceVersion &&
    watch.sourceVersion !== source.sourceVersion
  )
    throw new Error(
      "CONTEXT_SOURCE_CHANGED: 原始会话已替换，旧来源不可复用；请在新会话继续任务。",
    );
  return source;
}
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
      messages
        .filter(
          (message) =>
            message.role === "user" &&
            !isSupervisionPrompt(message.text) &&
            !message.text.startsWith("<hook_prompt"),
        )
        .flatMap((message) =>
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
  snapshots: SupervisionPlan[] = [],
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
      const candidate = path.resolve(realRoot, reference);
      if (!candidate.startsWith(`${realRoot}${path.sep}`))
        throw new Error("计划引用不能跨项目。");
      const planPath = path.relative(realRoot, candidate);
      try {
        const file = await realpath(candidate);
        if (!file.startsWith(`${realRoot}${path.sep}`))
          throw new Error("计划引用不能跨项目。");
        const info = await stat(file);
        if (!info.isFile() || info.size > INPUT_BUDGET_BYTES)
          throw new Error("计划过大或不可读，请明确任务范围。");
        const text = await readFile(file, "utf8");
        return {
          path: planPath,
          digest: digest(text),
          text,
          availability: "current",
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // A missing child must not turn a symlink outside the project into an allowed path.
        let parent = path.dirname(candidate);
        while (true) {
          try {
            const resolvedParent = await realpath(parent);
            if (
              resolvedParent !== realRoot &&
              !resolvedParent.startsWith(`${realRoot}${path.sep}`)
            )
              throw new Error("计划引用不能跨项目。");
            break;
          } catch (parentError) {
            if ((parentError as NodeJS.ErrnoException).code !== "ENOENT")
              throw parentError;
            parent = path.dirname(parent);
          }
        }
        const snapshot = snapshots.find((plan) => plan.path === planPath);
        if (snapshot?.text && snapshot.availability !== "missing")
          return { ...snapshot, availability: "snapshot" };
        return {
          path: planPath,
          digest: digest(""),
          text: "",
          availability: "missing",
        };
      }
    }),
  );
}
export async function refreshReferencedPlans(
  root: string,
  watch: TaskWatch,
  messages: ConversationMessage[],
) {
  const start = messages.findIndex(
    (m) => m.id === watch.taskStartMessageId && m.role === "user",
  );
  if (start < 0) throw new Error("找不到原始任务起点，请重新核对任务来源。");
  watch.plans = await readPlans(root, watch.goalDefinition ? watch.goalDefinition.plans.map((p) => p.path) : referencedPlans(messages), watch.plans);
}
export function buildSupervisionInput(
  watch: TaskWatch,
  content: ConversationContent,
  reply: SupervisionInput["currentReply"],
  previousContinuation?: PreviousSupervisionContinuation,
): SupervisionInput {
  const messages = messagesFrom(content);
  const start = messages.findIndex(
    (m) => m.id === watch.taskStartMessageId && m.role === "user",
  );
  if (start < 0) throw new Error("找不到原始任务起点，请重新核对任务来源。");
  const task = messages[start]!;
  const updates = messages.filter(
    (m) =>
      m.id !== task.id &&
      m.role === "user" &&
      !isSupervisionPrompt(m.text) &&
      !m.text.startsWith("<hook_prompt"),
  );
  if (watch.goalDefinition?.manualInstruction) updates.push(watch.goalDefinition.manualInstruction);
  updates.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  const recent = messages.filter(
    (m) =>
      m.id !== reply.id && m.role === "assistant" && m.phase !== "commentary",
  );
  const input: SupervisionInput = {
    task,
    goal: watch.goalDefinition?.objective ?? watch.goalOverride ?? task.text,
    goalDefinition: watch.goalDefinition,
    plan: watch.plans,
    userUpdates: updates,
    recentExchanges: recent,
    currentReply: reply,
    ...(previousContinuation ? { previousContinuation } : {}),
  };
  const size = () => Buffer.byteLength(JSON.stringify(input));
  if (size() > INPUT_BUDGET_BYTES)
    throw new Error(
      "必要上下文超过 180000 字节硬上限；本次未自动继续，监听保持开启。",
    );
  return input;
}
