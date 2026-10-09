import type {
  TaskHandoffEvidence,
  TaskHandoffItem,
  TaskHandoffTarget,
} from "@runweave/shared/task-handoff";
import type { ActivityStore } from "../activity/recording/store";
import { redactExcerpt } from "../experience/evidence";

/** The source reader has already bound every entry to the same target. */
export function preserveHandoffPairs(
  results: TaskHandoffItem[],
  evidence: TaskHandoffEvidence[],
) {
  const byId = new Map(evidence.map((entry) => [entry.id, entry]));
  const paired = results.map((item) => {
    const ids = new Set(item.evidenceIds);
    for (const id of item.evidenceIds) {
      const result = byId.get(id);
      if (result?.kind !== "agent.tool.completed" || !result.toolUseId)
        continue;
      const requests = evidence.filter(
        (entry) =>
          entry.kind === "agent.tool.requested" &&
          entry.toolUseId === result.toolUseId &&
          Date.parse(entry.occurredAt) <= Date.parse(result.occurredAt),
      );
      // Ambiguous identities are not proof of a pair.
      if (requests.length === 1) ids.add(requests[0]!.id);
    }
    return { ...item, evidenceIds: [...ids] };
  });
  const ids = new Set(paired.flatMap((item) => item.evidenceIds));
  return {
    results: paired,
    evidence: evidence.filter((entry) => ids.has(entry.id)),
  };
}

/** Explicit refresh can repair old cards without reclassifying their results. */
export async function recoverHandoffRequests(
  target: TaskHandoffTarget,
  evidence: TaskHandoffEvidence[],
  store: ActivityStore | null,
): Promise<TaskHandoffEvidence[]> {
  const recovered = [...evidence];
  if (!store) return recovered;
  let remainingBytes = 64_000;
  const missing = evidence.filter(
    (entry) =>
      entry.kind === "agent.tool.completed" &&
      entry.toolUseId &&
      !evidence.some(
        (request) =>
          request.kind === "agent.tool.requested" &&
          request.toolUseId === entry.toolUseId,
      ),
  );
  for (const result of missing.slice(0, 24)) {
    if (remainingBytes <= 0) break;
    try {
      const page = await store.facts({
        terminalSessionId: target.terminalSessionId,
        threadId: target.threadId,
        operationId: result.toolUseId!,
        eventName: "agent.tool.requested",
        limit: 2,
      });
      if (page.nextCursor || page.facts.length !== 1) continue;
      const fact = page.facts[0]!;
      if (
        fact.eventName !== "agent.tool.requested" ||
        fact.scope.terminalSessionId !== target.terminalSessionId ||
        fact.scope.threadId !== target.threadId ||
        (fact.scope.panelId ?? null) !== target.panelId ||
        fact.scope.runId ||
        fact.payload.toolUseId !== result.toolUseId ||
        !(Date.parse(fact.occurredAt) <= Date.parse(result.occurredAt))
      )
        continue;
      const parts: string[] = [];
      for (const descriptor of fact.contentDescriptors) {
        if (
          descriptor.availability !== "available" ||
          descriptor.byteLength > 40_000
        )
          continue;
        const content = await store.content(descriptor.contentId);
        if (!content?.bytesBase64) continue;
        const raw = Buffer.from(content.bytesBase64, "base64").toString("utf8");
        if (/data:image\/|"(?:input_image|image_url)"/.test(raw)) continue;
        parts.push(redactExcerpt(raw));
      }
      const text = parts.join("\n");
      if (!text) continue;
      const excerpt = text.slice(
        0,
        Math.min(4000, Math.floor(remainingBytes / 3)),
      );
      remainingBytes -= Buffer.byteLength(excerpt);
      if (recovered.some((entry) => entry.id === fact.eventId)) continue;
      recovered.push({
        id: fact.eventId,
        kind: "agent.tool.requested",
        toolUseId: result.toolUseId,
        occurredAt: fact.occurredAt,
        text: excerpt,
        truncated: true,
      });
    } catch {
      // Missing/expired evidence leaves the existing advisory result unchanged.
    }
  }
  return recovered;
}
