import type { ActivityFactDto } from "@runweave/shared/activity";
import type { ActivityStore } from "../activity/recording/store";
import { redactExcerpt } from "./evidence";

export interface LearningSource {
  terminalSessionId: string;
  threadId: string;
  panelId: string | null;
  completedAt: string;
  channel: "stable" | "beta" | "dev";
  /** Completion-time Activity snapshot; optional for jobs queued by older versions. */
  asOfActivityOffset?: number;
}
export interface LearningFact {
  id: string;
  kind: string;
  toolUseId: string | null;
  toolName: string | null;
  text: string;
}

/** Use stored tool results, never a completion summary as proof of success. */
export async function readLearningFacts(
  store: ActivityStore | null,
  source: LearningSource,
): Promise<LearningFact[]> {
  if (!store) throw new Error("experience_activity_unavailable");
  const selected: ActivityFactDto[] = [];
  let cursor: string | undefined;
  let asOfActivityOffset = source.asOfActivityOffset;
  let foundBoundary = false;
  // A bounded scan also recovers older jobs without a completion-time snapshot.
  for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
    const page = await store.facts({
      threadId: source.threadId,
      terminalSessionId: source.terminalSessionId,
      runtimeChannel: source.channel,
      asOfActivityOffset,
      cursor,
      limit: 200,
    });
    asOfActivityOffset = page.asOfActivityOffset;
    for (const fact of page.facts) {
      if (
        fact.occurredAt > source.completedAt ||
        fact.scope.runId ||
        (fact.scope.panelId ?? null) !== source.panelId
      )
        continue;
      selected.push(fact);
      if (fact.eventName === "user.query.submit_requested") {
        foundBoundary = true;
        break;
      }
    }
    if (foundBoundary || !page.nextCursor) break;
    cursor = page.nextCursor;
    if (pageIndex === 49) throw new Error("experience_source_scan_limit");
  }
  if (!foundBoundary) throw new Error("experience_turn_boundary_missing");
  selected.reverse();
  const output: LearningFact[] = [];
  let bytes = 0;
  for (const fact of selected) {
    if (
      ![
        "user.query.submit_requested",
        "agent.tool.requested",
        "agent.tool.completed",
        "agent.response.observed",
      ].includes(fact.eventName)
    )
      continue;
    const text = await readFactText(store, fact);
    bytes += Buffer.byteLength(text);
    if (bytes > 160_000) throw new Error("experience_turn_too_large");
    output.push({
      id: fact.eventId,
      kind: fact.eventName,
      toolUseId:
        typeof fact.payload.toolUseId === "string"
          ? fact.payload.toolUseId
          : null,
      toolName:
        typeof fact.payload.toolName === "string"
          ? fact.payload.toolName
          : null,
      text,
    });
  }
  return output;
}

async function readFactText(
  store: ActivityStore,
  fact: ActivityFactDto,
): Promise<string> {
  const parts: string[] = [];
  for (const descriptor of fact.contentDescriptors) {
    if (descriptor.availability !== "available")
      throw new Error("experience_source_expired");
    const value = await store.content(descriptor.contentId);
    if (!value?.bytesBase64) throw new Error("experience_source_unavailable");
    const text = Buffer.from(value.bytesBase64, "base64").toString("utf8");
    if (Buffer.byteLength(text) > 40_000)
      throw new Error("experience_source_too_large");
    parts.push(redactExcerpt(text));
  }
  return parts.join("\n");
}
