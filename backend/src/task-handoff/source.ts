import type { AppServerCodexThreadDetail } from "@runweave/shared/app-server-events";
import type {
  TaskHandoffCard,
  TaskHandoffEvidence,
  TaskHandoffTarget,
} from "@runweave/shared/task-handoff";
import type { ActivityStore } from "../activity/recording/store";
import { redactExcerpt } from "../experience/evidence";

const MESSAGE_LIMIT = 4000;
const INPUT_LIMIT = 100_000;

export async function readHandoffSource(
  target: TaskHandoffTarget,
  detail: AppServerCodexThreadDetail,
  previous: TaskHandoffCard | null,
  store: ActivityStore | null,
) {
  const completed = detail.turns.filter((turn) => turn.status !== "inProgress");
  const known = new Set(previous?.turnIds ?? []);
  // Process oldest unseen turns first; a bounded batch never silently skips a turn.
  const turns = completed.filter((turn) => !known.has(turn.id)).slice(0, 4);
  const evidence: TaskHandoffEvidence[] = [...(previous?.evidence ?? [])];
  const limitations = new Set<string>();
  let bytes = JSON.stringify(evidence).length;
  const consumed: string[] = [];
  for (const turn of turns) {
    if (bytes > INPUT_LIMIT) break;
    consumed.push(turn.id);
    const messages =
      turn.messages.length > 12
        ? [...turn.messages.slice(0, 2), ...turn.messages.slice(-10)]
        : turn.messages;
    if (messages.length !== turn.messages.length)
      limitations.add("部分轮次消息较多，仅整理开头与最近消息。");
    for (const message of messages) {
      if (bytes > INPUT_LIMIT) {
        limitations.add("原生消息超出本次整理预算，当前轮次仅整理部分内容。");
        break;
      }
      const raw = redactExcerpt(message.text);
      // Keep both ends of large messages; truncation remains visible to analysis and UI.
      const text =
        raw.length > MESSAGE_LIMIT
          ? `${raw.slice(0, MESSAGE_LIMIT / 2)}\n[…内容截断…]\n${raw.slice(-MESSAGE_LIMIT / 2)}`
          : raw;
      if (raw.length > MESSAGE_LIMIT)
        limitations.add("部分原生消息过长，仅整理首尾摘录。");
      evidence.push({
        id: `native:${turn.id}:${message.id}`,
        kind: message.role,
        text,
        occurredAt:
          (message.role === "user" ? turn.startedAt : turn.completedAt) ??
          turn.startedAt ??
          detail.updatedAt,
        toolUseId: null,
        truncated: raw.length > MESSAGE_LIMIT,
      });
      bytes += text.length;
    }
  }
  const selectedTurns = turns.filter((turn) => consumed.includes(turn.id));
  const from = selectedTurns[0]?.startedAt;
  const to = selectedTurns.at(-1)?.completedAt;
  if (
    selectedTurns.some(
      (turn) => turn.messages.length === 0 || turn.itemsView === "notLoaded",
    )
  )
    limitations.add("部分原生轮次没有可读取的消息。");
  if (store && from && to) {
    try {
      let cursor: string | undefined;
      let asOfActivityOffset: number | undefined;
      for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
        const page = await store.facts({
          terminalSessionId: target.terminalSessionId,
          threadId: target.threadId,
          cursor,
          asOfActivityOffset,
          limit: 200,
        });
        asOfActivityOffset = page.asOfActivityOffset;
        let reachedStart = false;
        for (const fact of page.facts) {
          if (Date.parse(fact.occurredAt) < Date.parse(from)) {
            reachedStart = true;
            break;
          }
          if (
            Date.parse(fact.occurredAt) > Date.parse(to) ||
            fact.scope.runId ||
            (fact.scope.panelId ?? null) !== target.panelId
          )
            continue;
          if (
            fact.eventName !== "agent.tool.requested" &&
            fact.eventName !== "agent.tool.completed"
          )
            continue;
          if (bytes > INPUT_LIMIT) {
            limitations.add(
              "工具记录超出本次整理预算；未读取的记录不作为结论依据。",
            );
            break;
          }
          const parts: string[] = [];
          let truncated = false;
          for (const descriptor of fact.contentDescriptors) {
            if (
              descriptor.availability !== "available" ||
              descriptor.byteLength > 40_000
            ) {
              truncated = true;
              continue;
            }
            const value = await store.content(descriptor.contentId);
            if (!value?.bytesBase64) {
              truncated = true;
              continue;
            }
            const raw = Buffer.from(value.bytesBase64, "base64").toString(
              "utf8",
            );
            if (/data:image\/|"(?:input_image|image_url)"/.test(raw)) {
              truncated = true;
              continue;
            }
            parts.push(redactExcerpt(raw).slice(0, 4000));
            truncated ||= raw.length > 4000;
          }
          if (truncated)
            limitations.add(
              "部分工具记录过长、包含图片或已过期，仅保留可读取的文本摘录。",
            );
          if (!parts.length) continue;
          const text = parts.join("\n");
          bytes += text.length;
          evidence.push({
            id: fact.eventId,
            kind: fact.eventName,
            occurredAt: fact.occurredAt,
            text,
            truncated,
            toolUseId:
              typeof fact.payload.toolUseId === "string"
                ? fact.payload.toolUseId
                : null,
          });
        }
        if (reachedStart || !page.nextCursor || bytes > INPUT_LIMIT) break;
        cursor = page.nextCursor;
        if (pageIndex === 9) limitations.add("工具历史尚未全部读取。");
      }
    } catch {
      limitations.add(
        "Activity 暂不可用，当前仅根据原生会话和已保存记录整理。",
      );
    }
  } else if (selectedTurns.length)
    limitations.add("本批次没有可关联的工具记录时间范围，结果保留为会话报告。");
  return {
    evidence: [...new Map(evidence.map((entry) => [entry.id, entry])).values()],
    limitations: [...limitations],
    turnIds: [...known, ...consumed],
    more: completed.some(
      (turn) => !known.has(turn.id) && !consumed.includes(turn.id),
    ),
    changed: consumed.length > 0,
  };
}
