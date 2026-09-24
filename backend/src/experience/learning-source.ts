import { createHash } from "node:crypto";
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
  /** Text-only analysis cannot use omitted images to establish an outcome. */
  omittedImageContent?: boolean;
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
    const { text, omittedImageContent } = await readFactText(store, fact);
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
      ...(omittedImageContent ? { omittedImageContent: true } : {}),
    });
  }
  return output;
}

async function readFactText(
  store: ActivityStore,
  fact: ActivityFactDto,
): Promise<{ text: string; omittedImageContent: boolean }> {
  if (fact.contentDescriptors.length === 0) {
    throw new Error("experience_source_unavailable");
  }
  const parts: string[] = [];
  let omittedImageContent = false;
  for (const descriptor of fact.contentDescriptors) {
    if (descriptor.availability !== "available")
      throw new Error("experience_source_expired");
    const value = await store.content(descriptor.contentId);
    if (typeof value?.bytesBase64 !== "string")
      throw new Error("experience_source_unavailable");
    const raw = Buffer.from(value.bytesBase64, "base64").toString("utf8");
    const projected =
      fact.eventName === "agent.tool.completed"
        ? projectToolImages(raw)
        : { text: raw, omittedImageContent: false };
    const text = projected.text;
    omittedImageContent ||= projected.omittedImageContent;
    if (Buffer.byteLength(text) > 40_000)
      throw new Error("experience_source_too_large");
    parts.push(redactExcerpt(text));
  }
  return { text: parts.join("\n"), omittedImageContent };
}

/** Keep the original Activity content intact; only project known image blocks. */
function projectToolImages(text: string): {
  text: string;
  omittedImageContent: boolean;
} {
  let blocks: unknown;
  try {
    blocks = JSON.parse(text);
  } catch {
    return { text, omittedImageContent: false };
  }
  if (!Array.isArray(blocks)) return { text, omittedImageContent: false };
  let omittedImageContent = false;
  const projected = blocks.map((block: unknown) => {
    if (
      !block ||
      typeof block !== "object" ||
      !("type" in block) ||
      block.type !== "input_image" ||
      !("image_url" in block) ||
      typeof block.image_url !== "string" ||
      !block.image_url.startsWith("data:")
    )
      return block;
    omittedImageContent = true;
    return {
      type: "omitted_image",
      reason:
        "Image not inspected by text-only experience analysis; not outcome evidence",
      sourceBytes: Buffer.byteLength(block.image_url),
      sha256: createHash("sha256").update(block.image_url).digest("hex"),
    };
  });
  return {
    text: omittedImageContent ? JSON.stringify(projected) : text,
    omittedImageContent,
  };
}
